import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HostError } from '../host-error.mjs';
import { createBlankPdf, createTextPdf } from '../pdf-factory.mjs';
import { PREFLIGHT_PROFILES, serializePreflightReportXml } from '../preflight-rules.mjs';
import {
  PDF_PRINTER_MARKS_PROFILE,
} from '../pdf-printer-marks-writer.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
import {
  assembleBarcodeDecorationPdf,
} from './specialist-embed-pdf.mjs';

function structuralReview(profile, source, extraFindings = []) {
  const latin1 = source.toString('latin1');
  const findings = [
    { id: 'pdf-header', status: latin1.startsWith('%PDF-') ? 'pass' : 'fail', summary: 'PDF header check' },
    { id: 'encrypt', status: latin1.includes('/Encrypt') ? 'fail' : 'pass', summary: 'Encryption presence' },
    { id: 'eof', status: latin1.includes('%%EOF') ? 'pass' : 'indeterminate', summary: 'EOF marker' },
    ...extraFindings,
  ];
  return Object.freeze({
    kind: 'standards-review',
    profile,
    findings: Object.freeze(findings),
    conforming: findings.every((f) => f.status !== 'fail'),
    certified: false,
    authority: 'local-structural-only-v1',
  });
}

export function standardsPdfA(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const report = structuralReview('pdf-a', source, [{ id: 'pdfa-note', status: 'indeterminate', summary: 'Not a certified PDF/A validator result' }]);
  return result('standards.pdf-a', { method: 'local-standards-pdfa-structural', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
export function standardsPdfX(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const report = structuralReview('pdf-x', source, [{ id: 'output-intent-hint', status: latin1Has(source, '/OutputIntent') ? 'pass' : 'indeterminate', summary: 'OutputIntent marker' }]);
  return result('standards.pdf-x', { method: 'local-standards-pdfx-structural', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
export function standardsPdfUa(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const report = structuralReview('pdf-ua', source, [{ id: 'markinfo', status: latin1Has(source, '/MarkInfo') || latin1Has(source, '/StructTreeRoot') ? 'pass' : 'indeterminate', summary: 'Tag structure markers' }]);
  return result('standards.pdf-ua', { method: 'local-standards-pdfua-structural', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
export function standardsPdfE(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const report = structuralReview('pdf-e', source);
  return result('standards.pdf-e', { method: 'local-standards-pdfe-structural', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
export function standardsPdfVt(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const report = structuralReview('pdf-vt', source);
  return result('standards.pdf-vt', { method: 'local-standards-pdfvt-structural', report, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
export function standardsPdfTwo(ctx = {}) {
  const source = ctx.sourcePdf ? requireBytes(ctx.sourcePdf, 'sourcePdf') : createBlankPdf({ pages: 1 });
  const version = (source.toString('latin1').match(/%PDF-([0-9.]+)/) || [])[1] || null;
  const report = structuralReview('pdf-two', source, [{ id: 'version', status: version ? 'pass' : 'fail', summary: 'Declared version ' + (version ?? 'missing') }]);
  return result('standards.pdf-two', { method: 'local-standards-pdf20-structural', report, version, reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'), certified: false });
}
function latin1Has(buf, s) { return buf.toString('latin1').includes(s); }

const SHA256 = /^[0-9a-f]{64}$/u;
const PRINT_AUTHORITY = new WeakSet();
const SOURCE_BOUND_PRINT_CAPABILITIES = new Set([
  'preflight.profiles', 'preflight.reports', 'print.transparency-flattening',
  'print.bleed-marks', 'print.imposition', 'print.font-inspection-embedding',
  'print.image-resolution-compression',
  'color.convert', 'color.output-intents',
]);

function abort(signal) {
  if (signal?.aborted) throw new HostError('JOB_CANCELLED', 'Professional print delivery was cancelled.', 499);
}

function runtime(ctx) {
  if (!PRINT_AUTHORITY.has(ctx.printAuthority)) {
    fail('INVALID_PRODUCTION_AUTHORITY', 'Professional print delivery requires a composition-root authority.', 503);
  }
  return ctx.printAuthority;
}

function authority(ctx, key, label) {
  const value = runtime(ctx)[key];
  if (!value) fail('INVALID_PRODUCTION_AUTHORITY', `${label} is unavailable from the professional print authority.`, 503);
  return value;
}

async function retainedBytes(store, kind, id, expectedSha256, revokedCode, expectedSize) {
  const record = kind === 'artifact' ? store.getArtifact(id) : store.getDocument(id);
  const filePath = kind === 'artifact' ? record?.filePath : (record ? store.getSourcePath(id) : null);
  if (!record || record.sha256 !== expectedSha256
    || (expectedSize !== undefined && record.size !== expectedSize)
    || typeof filePath !== 'string') {
    fail(revokedCode, `The retained ${kind} no longer matches its validated receipt.`, 409);
  }
  const bytes = await readFile(filePath);
  if (bytes.length !== record.size || (expectedSize !== undefined && bytes.length !== expectedSize)
    || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    fail(revokedCode, `The retained ${kind} bytes no longer match its validated receipt.`, 409);
  }
  return bytes;
}

async function revokeAfterFailure(store, kind, id, error) {
  try {
    await (kind === 'artifact' ? store.deleteArtifact(id) : store.deleteDocument(id));
  } catch (cleanupError) {
    throw new HostError('PROFESSIONAL_PRINT_CLEANUP_FAILED', 'Professional print delivery could not revoke its failed retained output.', 500, {
      cause: new AggregateError([error, cleanupError]),
    });
  }
  throw error;
}

function retainedOutput(capabilityId, outcome) {
  if (capabilityId === 'print.transparency-flattening' && typeof outcome?.outputDocumentId === 'string') {
    return Object.freeze({ kind: 'document', id: outcome.outputDocumentId });
  }
  if (['print.bleed-marks', 'print.imposition'].includes(capabilityId)
    && typeof outcome?.artifactId === 'string') {
    return Object.freeze({ kind: 'artifact', id: outcome.artifactId });
  }
  if (['color.convert', 'color.output-intents'].includes(capabilityId)
    && typeof outcome?.artifactId === 'string') {
    return Object.freeze({ kind: 'artifact', id: outcome.artifactId });
  }
  return null;
}

/**
 * Composition-root boundary for services that can create or inspect retained
 * professional-print outputs. The opaque authority cannot be synthesized with
 * a prototype-shaped request object.
 */
export function createProfessionalPrintDelivery({ store, services, deliver, list }) {
  if (!store || !services || typeof deliver !== 'function' || typeof list !== 'function') {
    throw new TypeError('Professional print delivery requires the document store, real services, delivery entrypoint, and handler inventory.');
  }
  const printAuthority = Object.freeze({
    store,
    prepress: services.prepress,
    conversion: services.conversion,
    printerMarks: services.printerMarks,
    pdf: services.service,
  });
  PRINT_AUTHORITY.add(printAuthority);
  async function deliverSourceBound(capabilityId, context = {}) {
    if (!SOURCE_BOUND_PRINT_CAPABILITIES.has(capabilityId)) return deliver(capabilityId, context);
    if (typeof context.documentId !== 'string' || context.documentId.length === 0) {
      fail('SOURCE_DOCUMENT_UNAVAILABLE', 'Professional print delivery requires a source document id.', 503);
    }
    const { signal } = context;
    abort(signal);
    await store.verifySource(context.documentId);
    const source = store.getDocument(context.documentId);
    if (!SHA256.test(context.sourceSha256 ?? '') || context.sourceSha256 !== source?.sha256) {
      fail('SOURCE_VERSION_MISMATCH', 'Professional print delivery requires the current lowercase source digest.', 409);
    }
    const sourcePdf = await readFile(store.getSourcePath(context.documentId));
    let deliveredOutput = null;
    try {
      const sourceSha256 = createHash('sha256').update(sourcePdf).digest('hex');
      if (sourcePdf.length !== source.size || sourceSha256 !== source.sha256) {
        throw new HostError('SOURCE_INTEGRITY_FAILED', 'The authoritative professional print source changed during resolution.', 500);
      }
      await store.verifySource(context.documentId);
      abort(signal);
      const outcome = await deliver(capabilityId, { ...context, sourcePdf, sourceSha256, printAuthority });
      deliveredOutput = retainedOutput(capabilityId, outcome);
      await store.verifySource(context.documentId);
      const retainedSource = await readFile(store.getSourcePath(context.documentId));
      try {
        if (retainedSource.length !== source.size || createHash('sha256').update(retainedSource).digest('hex') !== source.sha256) {
          throw new HostError('SOURCE_INTEGRITY_FAILED', 'The professional print source changed during delivery.', 500);
        }
      } finally {
        retainedSource.fill(0);
      }
      abort(signal);
      return outcome;
    } catch (error) {
      if (deliveredOutput) {
        return revokeAfterFailure(store, deliveredOutput.kind, deliveredOutput.id, error);
      }
      throw error;
    } finally {
      sourcePdf.fill(0);
    }
  }
  return Object.freeze({ deliver: deliverSourceBound, deliverSourceBound, list });
}
function boundDocument(ctx, label = 'document') {
  const store = authority(ctx, 'store', 'DocumentStore');
  if (typeof ctx.documentId !== 'string' || ctx.documentId.length === 0) fail('SOURCE_DOCUMENT_UNAVAILABLE', `${label} id is required.`, 503);
  const document = store.getDocument(ctx.documentId);
  if (!document || document.id !== ctx.documentId || !SHA256.test(document.sha256) || ctx.sourceSha256 !== document.sha256) fail('SOURCE_VERSION_MISMATCH', `${label} digest is not authoritative for the current document.`, 409);
  return document;
}
function strictReport(report, profile) {
  if (!report || report.kind !== 'preflight-review' || report.localOnly !== true || report.authoritative !== false
    || !Array.isArray(report.limitations) || report.limitations.length < 1 || !SHA256.test(report.reportSha256 ?? '')
    || report.profile?.id !== profile) fail('PREFLIGHT_REPORT_INVALID', 'The preflight report is not a strict local non-authoritative report.', 502);
  serializePreflightReportXml(report);
  return report;
}


export {
  SHA256, structuralReview, latin1Has, abort, runtime, authority, retainedBytes,
  revokeAfterFailure, retainedOutput, boundDocument, strictReport,
};
