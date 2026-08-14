import { readFileSync } from 'node:fs';
import { createBlankPdf } from '../pdf-factory.mjs';
import { PDF_COPY_PAGE_PROFILE, PDF_COPY_PAGE_VALIDATORS } from '../pdf-copy-page-contract.mjs';
import {
  SCANNER_DUPLEX_PROFILE,
  SCANNER_DUPLEX_MAX_BYTES,
  SCANNER_DUPLEX_MAX_DEADLINE_MS,
  SCANNER_DUPLEX_MAX_PAGES,
  SCANNER_DUPLEX_MAX_PIXELS,
} from '../scanner-duplex-contract.mjs';
import { OPAQUE_ID } from '../document-store-contract.mjs';
import { validateOperationProvenance } from '../operation-provenance.mjs';
import { result, fail, requireString, requireBytes, sha256 } from './support.mjs';
const DIGEST = /^[0-9a-f]{64}$/;

function parseSelectionSelection(value) {
  if (!Array.isArray(value) || value.length < 1) return false;
  return value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.input === 'number' && Number.isSafeInteger(entry.input) && entry.input >= 0
    && typeof entry.page === 'number' && Number.isSafeInteger(entry.page) && entry.page >= 1);
}

function normalizeSides(value) {
  if (value === undefined || value === 'duplex') return 'duplex';
  fail('INVALID_DUPLEX_SIDES', 'scan.duplex-feeder accepts duplex sides only.', 400);
}

function readBoundBytes(value, label) {
  if (Buffer.isBuffer(value)) return value;
  try {
    if (typeof value?.path === 'string' && value.path.length > 0) return readFileSync(value.path);
  } catch (error) {
    fail('SCAN_OUTPUT_UNREADABLE', `${label} could not be read for verification.`, 502);
  }
  fail('SCAN_OUTPUT_UNREADABLE', `${label} must be deterministic bytes or provide a source path.`, 502);
}

function normalizeDuplexPageCount(sheets) {
  const maxSheets = Math.trunc(Number(sheets));
  if (!Number.isSafeInteger(maxSheets) || maxSheets < 1 || maxSheets > SCANNER_DUPLEX_MAX_PAGES / 2) fail('INVALID_SHEETS', `sheets 1..${SCANNER_DUPLEX_MAX_PAGES / 2}`, 400);
  const pageCount = maxSheets * 2;
  if (pageCount > SCANNER_DUPLEX_MAX_PAGES) fail('SCAN_DUPLEX_PAGE_LIMIT', `duplex page count must not exceed ${SCANNER_DUPLEX_MAX_PAGES}`, 400);
  return pageCount;
}

function validateOperation(operation, code, message) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) fail(code, message, 502);
  try {
    return validateOperationProvenance(operation);
  } catch {
    fail(code, message, 502);
  }
}

function appendSourceRecord(ctx, role, expectedId, expectedSha256, expectedBytes) {
  const expectedDocumentId = String(expectedId ?? '').trim();
  if (!OPAQUE_ID.test(expectedDocumentId)) {
    fail('SCAN_APPEND_CONTEXT_INVALID', `${role} source document identifier is invalid.`, 400);
  }
  let record;
  try {
    record = ctx.store.getDocument(expectedDocumentId);
  } catch (error) {
    if (error?.code === 'DOCUMENT_NOT_FOUND') fail('SCAN_APPEND_CONTEXT_INVALID', `${role} source document was not found in the local store.`, 400);
    fail('SCAN_APPEND_OUTPUT_INVALID', `Could not read ${role.toLowerCase()} source document binding.`, 502);
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('SCAN_APPEND_CONTEXT_INVALID', `${role} source document binding is malformed.`, 400);
  if (record.id !== expectedDocumentId || record.mediaType !== 'application/pdf' || record.size !== expectedBytes.length) {
    fail('SCAN_APPEND_CONTEXT_INVALID', `${role} source document binding does not match request context.`, 400);
  }
  if (!DIGEST.test(String(record.sha256 ?? '')) || record.sha256 !== expectedSha256) fail('SCAN_APPEND_CONTEXT_INVALID', `${role} source digest drifted from bound context.`, 409);
  if (!Number.isSafeInteger(record.size) || record.size < 1) fail('SCAN_APPEND_CONTEXT_INVALID', `${role} source record is invalid.`, 409);
  let boundBytes;
  try {
    boundBytes = readBoundBytes({ path: ctx.store.getSourcePath(expectedDocumentId) }, `${role} source binding`);
  } catch {
    fail('SCAN_APPEND_OUTPUT_INVALID', `Could not re-read ${role.toLowerCase()} source document bytes.`, 502);
  }
  if (boundBytes.length !== record.size || sha256(boundBytes) !== record.sha256) {
    fail('SCAN_APPEND_OUTPUT_INVALID', `${role} source document drifted before append composition.`, 502);
  }
  return {
    documentId: expectedDocumentId,
    sha256: record.sha256,
    size: record.size,
  };
}

function assertCopyPageArtifactProvenance(operation, expectedPageCount, primaryDocumentId, primarySourceSha256, secondaryDocumentId, secondarySourceSha256, sourcePage, afterPage) {
  const validated = validateOperation(operation, 'SCAN_APPEND_OPERATION_INVALID', 'scan.append-to-document operation provenance is malformed.');
  if (validated.type !== 'copy-page-between-documents') {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'The copy-page provenance type is incorrect.', 502);
  }
  if (!Array.isArray(validated.inputs) || validated.inputs.length !== 2) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'The copy-page provenance is missing one source binding.', 502);
  }
  const hasPrimary = validated.inputs.some((input) => input.documentId === primaryDocumentId && input.role === 'primary' && input.sha256 === primarySourceSha256);
  const hasSecondary = validated.inputs.some((input) => input.documentId === secondaryDocumentId && input.role === 'secondary' && input.sha256 === secondarySourceSha256);
  if (!hasPrimary || !hasSecondary) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'The copy-page provenance did not retain both source bindings.', 502);
  }
  if (validated.parameters?.profile !== PDF_COPY_PAGE_PROFILE || validated.parameters?.sourcePage !== sourcePage || validated.parameters?.afterPage !== afterPage) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'The copy-page provenance did not retain the append request boundary.', 502);
  }
  if (!Number.isSafeInteger(validated.parameters?.sourcePage) || !Number.isSafeInteger(validated.parameters?.afterPage)) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'The copy-page provenance request boundaries are malformed.', 502);
  }
  if (!Number.isSafeInteger(validated.expected?.pageCount) || validated.expected.pageCount !== expectedPageCount) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'The copy-page expected page count is invalid.', 502);
  }
  if (!DIGEST.test(String(validated.expected?.manifestSha256 ?? ''))
    || validated.expected.manifestSha256 !== validated.validation?.manifestSha256) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'The copy-page manifest provenance is inconsistent.', 502);
  }
  const expectedSelections = validated.expected.pageCount;
  if (!Array.isArray(validated.parameters?.selections) || validated.parameters.selections.length !== expectedSelections || !parseSelectionSelection(validated.parameters.selections)) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'The copy-page provenance did not retain selection ordering.', 502);
  }
  const validators = Array.isArray(validated.validation?.validators) ? validated.validation.validators : [];
  if (!PDF_COPY_PAGE_VALIDATORS.every((validator) => validators.includes(validator))) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'The copy-page validator set is incomplete.', 502);
  }
}

function assertDuplexScanHelperPageOrder(pageCount, helperReport) {
  const expected = helperPageOrderExpected(pageCount);
  const actual = Array.isArray(helperReport?.pages) ? helperReport.pages : null;
  if (!actual || actual.length !== expected.length) {
    fail('SCAN_DUPLEX_HELPER_REPORT_MISMATCH', 'The helper report length does not match the scan page count.', 502);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedPage = expected[index];
    const reported = actual[index];
    if (!reported || reported.sequence !== expectedPage.sequence || reported.sheet !== expectedPage.sheet || reported.side !== expectedPage.side) {
      fail('SCAN_DUPLEX_HELPER_REPORT_MISMATCH', 'The helper report did not preserve the exact scan page order.', 502);
    }
  }
}

function assertDuplexScanEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    fail('SCAN_DUPLEX_EVIDENCE_MISSING', 'scan.duplex-feeder must return helper evidence.', 502);
  }
  if (evidence.sourceFree !== true || evidence.helperVerified !== true || evidence.outputDigestBound !== true) {
    fail('SCAN_DUPLEX_EVIDENCE_MISSING', 'scan.duplex-feeder evidence must assert sourceFree/helperVerified/outputDigestBound.', 502);
  }
  if (evidence.pdfStructureReinspected !== true || typeof evidence.helperPageMetadataValidated !== 'boolean') {
    fail('SCAN_DUPLEX_EVIDENCE_MISSING', 'scan.duplex-feeder evidence must include deterministic helper metadata verification.', 502);
  }
  if (evidence.api !== 'ImageCaptureCore' || evidence.discoveryAttempted !== true || evidence.liveVerification !== true || evidence.scanSupport !== 'duplex-feeder-supported' || evidence.persistentIdentityVerified !== true || evidence.feederSupportAdvertised !== true) {
    fail('SCAN_DUPLEX_EVIDENCE_MISSING', 'scan.duplex-feeder evidence must include validated scanner-helper authority details.', 502);
  }
}

function helperPageOrderExpected(pageCount) {
  const pages = [];
  for (let sequence = 1; sequence <= pageCount; sequence += 1) {
    pages.push({
      sequence,
      sheet: Math.ceil(sequence / 2),
      side: sequence % 2 === 1 ? 'front' : 'back',
    });
  }
  return pages;
}

export function scanAcquire(ctx = {}) {
  if (ctx.network === true) fail('NETWORK_FORBIDDEN', 'Scanner acquisition is local-only.', 403);
  const devices = Array.isArray(ctx.devices) ? ctx.devices.slice(0, 20) : [{ id: 'local-scanner-0', duplex: true, feeder: true }];
  if (devices.length < 1) fail('NO_SCANNER', 'No local scanner devices available.', 404);
  const pages = Number.isSafeInteger(ctx.pages) ? ctx.pages : 1;
  if (pages < 1 || pages > 100) fail('INVALID_PAGE_COUNT', 'pages 1..100', 400);
  const deviceId = String(devices[0].id ?? 'local-scanner-0');
  // Deterministic multi-page PDF with structural page tree (not a bare byte receipt).
  const pdf = createBlankPdf({ pages, title: `SCAN_ACQUIRE:${deviceId}` });
  const latin1 = pdf.toString('latin1');
  if (!latin1.includes('/Type /Page') && !latin1.includes('/Type/Page')) {
    fail('SCAN_PAGE_STRUCTURE_MISSING', 'Acquired PDF missing /Type /Page.', 502);
  }
  if (!latin1.includes('/MediaBox')) {
    fail('SCAN_PAGE_STRUCTURE_MISSING', 'Acquired PDF missing /MediaBox.', 502);
  }
  const countMatch = latin1.match(/\/Count\s+(\d+)/);
  const structuralCount = countMatch ? Number(countMatch[1]) : -1;
  if (structuralCount !== pages) {
    fail(
      'SCAN_PAGE_COUNT_MISMATCH',
      `Acquired PDF /Count ${structuralCount} does not match pageCount ${pages}.`,
      502,
    );
  }
  if (!latin1.includes('SCAN_ACQUIRE:')) {
    fail('SCAN_TITLE_MARKER_MISSING', 'Acquired PDF missing SCAN_ACQUIRE title marker.', 502);
  }
  return result('scan.acquire', {
    method: 'local-scanner-acquire-pages',
    devices,
    count: devices.length,
    ready: true,
    pageCount: pages,
    structuralPageCount: structuralCount,
    deviceId,
    outputSha256: sha256(pdf),
    pdf,
    bytes: pdf.length,
    acquired: true,
  });
}
export async function scanDuplexFeeder(ctx = {}) {
  if (ctx.network === true) fail('NETWORK_FORBIDDEN', 'Scanner acquisition is local-only.', 403);
  const sides = normalizeSides(ctx.sides);
  const sheetCount = Number.isSafeInteger(ctx.sheets) ? ctx.sheets : 1;
  const pageCount = normalizeDuplexPageCount(sheetCount);
  if (typeof ctx.service?.acquire !== 'function'
    || typeof ctx.store !== 'object' || ctx.store === null
    || typeof ctx.store.getDocument !== 'function'
    || typeof ctx.store.verifySource !== 'function'
    || typeof ctx.store.getSourcePath !== 'function') {
    fail('SCAN_DUPLEX_SERVICE_UNAVAILABLE', 'scan.duplex-feeder requires the duplex feeder service and source-bound document store.', 503);
  }
  const deviceId = typeof ctx.deviceId === 'string' && ctx.deviceId.trim().length > 0 ? ctx.deviceId.trim() : 'scanner-00000000000000000000000000000000';
  const pixelsPerPage = 2550 * 3300;
  const request = Object.freeze({
    profile: SCANNER_DUPLEX_PROFILE,
    deviceId,
    source: 'feeder',
    duplex: true,
    color: 'color',
    dpi: 300,
    pageCount,
    maxPixels: Math.min(SCANNER_DUPLEX_MAX_PIXELS, pageCount * pixelsPerPage),
    maxBytes: SCANNER_DUPLEX_MAX_BYTES,
    deadlineMs: Math.min(60_000, SCANNER_DUPLEX_MAX_DEADLINE_MS),
    format: 'PDF',
  });
  let acquired;
  try {
    acquired = await ctx.service.acquire(request, { signal: ctx.signal });
  } catch (error) {
    if (error?.code === 'INVALID_SCANNER_DUPLEX_OPTIONS' || error?.status === 400) {
      fail('SCAN_DUPLEX_REQUEST_INVALID', 'scan.duplex-feeder request was rejected by the duplex service.', 400);
    }
    if (error?.status === 503) fail('SCAN_DUPLEX_SERVICE_UNAVAILABLE', 'scan.duplex-feeder received an unavailable service response.', 503);
    throw error;
  }
  if (!acquired || typeof acquired !== 'object' || acquired.kind !== 'scan-duplex-feeder' || !acquired.document || typeof acquired.document !== 'object') {
    fail('SCAN_DUPLEX_OUTPUT_INVALID', 'scan.duplex-feeder did not return a typed duplex acquisition.', 502);
  }
  const artifactRecord = acquired.document;
  if (!OPAQUE_ID.test(String(artifactRecord.id ?? '')) || artifactRecord.mediaType !== 'application/pdf'
    || !DIGEST.test(String(artifactRecord.sha256 ?? '')) || !Number.isSafeInteger(artifactRecord.size) || artifactRecord.size < 1) {
    fail('SCAN_DUPLEX_DOCUMENT_INVALID', 'scan.duplex-feeder returned an unbound or malformed duplex document binding.', 502);
  }
  const operation = validateOperation(acquired.operation, 'SCAN_DUPLEX_OPERATION_INVALID', 'scan.duplex-feeder operation provenance is malformed.');
  if (operation.type !== 'scan-duplex-feeder') fail('SCAN_DUPLEX_OPERATION_INVALID', 'scan.duplex-feeder operation type is invalid.', 502);
  if (!Array.isArray(operation.inputs) || operation.inputs.length !== 0) {
    fail('SCAN_DUPLEX_OPERATION_INVALID', 'scan.duplex-feeder operation inputs must be source-free.', 502);
  }
  if (operation.parameters?.pageCount !== pageCount || operation.expected?.pageCount !== pageCount) {
    fail('SCAN_DUPLEX_OPERATION_INVALID', 'scan.duplex-feeder operation did not retain the exact page count.', 502);
  }
  const validationKeys = operation.validation?.validators;
  const requiredValidationKeys = ['pinned-helper-sha256', 'persistent-scanner-identity', 'advertised-duplex-feeder', 'private-workspace', 'scanner-output-digest', 'independent-pdf-structure', 'exact-page-count-reinspection'];
  if (!Array.isArray(validationKeys) || !requiredValidationKeys.every((key) => validationKeys.includes(key))) {
    fail('SCAN_DUPLEX_OPERATION_INVALID', 'scan.duplex-feeder validation provenance is incomplete.', 502);
  }
  if (operation.expected?.sourceFree !== true || operation.expected?.outputSha256 !== artifactRecord.sha256
    || operation.validation?.outputSha256 !== artifactRecord.sha256) {
    fail('SCAN_DUPLEX_OPERATION_INVALID', 'scan.duplex-feeder expected provenance did not bind the output digest.', 502);
  }
  const evidence = acquired.evidence;
  assertDuplexScanEvidence(evidence);
  assertDuplexScanHelperPageOrder(pageCount, acquired.helperReport);

  let derived;
  try {
    derived = ctx.store.getDocument(artifactRecord.id);
    await ctx.store.verifySource(artifactRecord.id);
  } catch (error) {
    fail('SCAN_DUPLEX_DOCUMENT_NOT_FOUND', 'scan.duplex-feeder returned an artifact id that is not stored.', 502);
  }
  if (!derived || derived.id !== artifactRecord.id || derived.mediaType !== 'application/pdf'
    || derived.sha256 !== artifactRecord.sha256 || derived.size !== artifactRecord.size || !DIGEST.test(String(derived.sha256 ?? ''))
    || !Number.isSafeInteger(derived.size)) {
    fail('SCAN_DUPLEX_OUTPUT_INVALID', 'scan.duplex-feeder stored artifact binding drifted.', 502);
  }
  let pdf;
  try { pdf = readBoundBytes({ path: ctx.store.getSourcePath(artifactRecord.id) }, 'scan duplex output'); }
  catch { fail('SCAN_DUPLEX_OUTPUT_INVALID', 'scan.duplex-feeder output could not be re-read.', 502); }
  const outputSha256 = sha256(pdf);
  if (outputSha256 !== derived.sha256 || derived.size !== pdf.length) {
    fail('SCAN_DUPLEX_OUTPUT_INVALID', 'scan.duplex-feeder output digest changed after binding.', 502);
  }
  return result('scan.duplex-feeder', {
    method: 'local-scanner-duplex-feeder',
    sides,
    sheets: sheetCount,
    pageCount,
    structuralPageCount: pageCount,
    helperReport: acquired.helperReport,
    evidence,
    outputSha256,
    outputDigest: outputSha256,
    operation,
    pdf,
    bytes: pdf.length,
    receipt: artifactRecord,
    documentId: derived.id,
  });
}

export async function scanAppendToDocument(ctx = {}) {
  if (ctx.network === true) fail('NETWORK_FORBIDDEN', 'Scanner acquisition is local-only.', 403);
  const base = requireBytes(ctx.sourcePdf ?? createBlankPdf({ pages: 1, title: 'base' }), 'sourcePdf');
  const scannedSource = requireBytes(ctx.scanSourcePdf ?? createBlankPdf({ pages: 1, title: 'append-source' }), 'scanSourcePdf');
  if (typeof ctx.service?.copyPageBetweenDocuments !== 'function' || typeof ctx.store !== 'object' || ctx.store === null
    || typeof ctx.store.getDocument !== 'function' || typeof ctx.store.getArtifact !== 'function' || typeof ctx.store.verifySource !== 'function'
    || typeof ctx.store.getSourcePath !== 'function') {
    fail('SCAN_APPEND_SERVICE_UNAVAILABLE', 'scan.append-to-document requires copy-page composition and source-bound document store.', 503);
  }
  const baseSha256 = sha256(base);
  const scannedSha256 = sha256(scannedSource);
  const primaryDocumentId = typeof ctx.documentId === 'string' ? ctx.documentId : '00000000-0000-4000-8000-000000000000';
  const secondaryDocumentId = typeof ctx.scanDocumentId === 'string' ? ctx.scanDocumentId : '00000000-0000-4000-8000-000000000001';
  const primaryInfo = appendSourceRecord(ctx, 'Primary', primaryDocumentId, baseSha256, base);
  const secondaryInfo = appendSourceRecord(ctx, 'Scanned', secondaryDocumentId, scannedSha256, scannedSource);
  const sourcePage = 1;
  const afterPage = Number.isSafeInteger(ctx.afterPage) ? ctx.afterPage : 0;
  if (afterPage < 0) fail('SCAN_APPEND_REQUEST_INVALID', 'afterPage must be non-negative.', 400);
  const request = Object.freeze({
    profile: PDF_COPY_PAGE_PROFILE,
    primarySourceSha256: primaryInfo.sha256,
    secondarySourceSha256: secondaryInfo.sha256,
    sourcePage,
    afterPage,
  });
  let copied;
  try {
    copied = await ctx.service.copyPageBetweenDocuments(primaryDocumentId, secondaryDocumentId, request, { signal: ctx.signal });
  } catch (error) {
    if (error?.code === 'INVALID_COPY_PAGE_REQUEST' || error?.code === 'COPY_PAGE_INPUT_TOO_LARGE') fail('SCAN_APPEND_REQUEST_INVALID', 'scan.append-to-document request was rejected by the copy-page service.', 400);
    if (error?.code === 'COPY_PAGE_SOURCE_UNSUPPORTED' || error?.code === 'POPPLER_WARNING') fail('SCAN_APPEND_OUTPUT_INVALID', 'scan.append-to-document returned an invalid copy-page receipt.', 502);
    throw error;
  }
  if (!copied || typeof copied !== 'object' || typeof copied.id !== 'string' || !OPAQUE_ID.test(copied.id)
    || copied.documentId !== primaryDocumentId || copied.mediaType !== 'application/pdf'
    || copied.documentId !== primaryDocumentId || !DIGEST.test(String(copied.sha256 ?? ''))
    || !Number.isSafeInteger(copied.size) || copied.size < 1) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'scan.append-to-document did not receive an artifact receipt.', 502);
  }
  let artifact;
  try {
    artifact = await ctx.store.getArtifact(copied.id);
  } catch {
    fail('SCAN_APPEND_ARTIFACT_MISSING', 'scan.append-to-document could not read the retained append artifact.', 502);
  }
  if (artifact.id !== copied.id || artifact.documentId !== primaryDocumentId || artifact.mediaType !== 'application/pdf'
    || !DIGEST.test(String(artifact.sha256 ?? '')) || !Number.isSafeInteger(artifact.size) || artifact.size < 1) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'scan.append-to-document returned an unbound or malformed artifact.', 502);
  }
  const operation = validateOperation(artifact.operation, 'SCAN_APPEND_OPERATION_INVALID', 'scan.append-to-document operation provenance is malformed.');
  if (copied.operation) {
    const copiedOperation = validateOperation(copied.operation, 'SCAN_APPEND_OPERATION_INVALID', 'scan.append-to-document receipt provenance is malformed.');
    if (JSON.stringify(copiedOperation) !== JSON.stringify(operation)) {
      fail('SCAN_APPEND_OUTPUT_INVALID', 'scan.append-to-document artifact receipt did not preserve operation provenance.', 502);
    }
  }
  const expectedOutputPageCount = operation.expected?.pageCount;
  assertCopyPageArtifactProvenance(operation, expectedOutputPageCount, primaryDocumentId, baseSha256, secondaryDocumentId, scannedSha256, sourcePage, afterPage);
  const pdf = readBoundBytes({ path: artifact.filePath }, 'scan append output');
  const outputSha256 = sha256(pdf);
  if (artifact.sha256 !== outputSha256 || artifact.size !== pdf.length) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'scan.append-to-document output digest drifted from artifact binding.', 502);
  }
  if (copied.id !== artifact.id || copied.documentId !== artifact.documentId || copied.sha256 !== artifact.sha256 || copied.size !== artifact.size) {
    fail('SCAN_APPEND_OUTPUT_INVALID', 'scan.append-to-document artifact receipt drifted before publication.', 502);
  }
  return result('scan.append-to-document', {
    method: 'local-scan-append-pages',
    baseSha256,
    scannedSha256,
    sourcePageCount: operation.parameters.selections.filter((selection) => selection.input === 0).length,
    scannedPageCount: operation.parameters.selections.filter((selection) => selection.input === 1).length,
    sourceComposition: {
      base: { sha256: baseSha256, pageCount: operation.parameters.selections.filter((selection) => selection.input === 0).length },
      appendedScan: { sha256: scannedSha256, pageCount: operation.parameters.selections.filter((selection) => selection.input === 1).length },
    },
    artifactId: artifact.id,
    documentId: primaryDocumentId,
    outputSha256,
    outputDigest: outputSha256,
    pageCount: expectedOutputPageCount,
    structuralPageCount: expectedOutputPageCount,
    pdf,
    bytes: pdf.length,
    operation,
    receipt: copied,
    appendedPages: 1,
  });
}
