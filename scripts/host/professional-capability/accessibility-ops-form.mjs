import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE } from '../pdf-accessibility-form-semantics-contract.mjs';
import {
  inspectPdfAccessibilityFormSemantics,
  writePdfAccessibilityFormSemantics,
} from '../pdf-accessibility-form-semantics-writer.mjs';
import { result, fail, requireBytes, sha256 } from './support.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function formProductionInput(ctx) {
  if (ctx.sourcePdf === undefined && ctx.sourceBytes === undefined) {
    fail('ACCESSIBILITY_FORM_SOURCE_REQUIRED', 'Accessible form repair requires explicit source PDF bytes.', 400);
  }
  const source = requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf', { max: 32 * 1024 * 1024 });
  const sourceSha256 = sha256(source);
  if (ctx.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The supplied accessible-form source digest does not match the source PDF.', 409);
  }
  if (typeof ctx.documentId !== 'string' || ctx.documentId.length < 1) {
    fail('ACCESSIBILITY_FORM_DOCUMENT_REQUIRED', 'Accessible form repair requires an explicit document identity.', 400);
  }
  if (!ctx.formRequest || typeof ctx.formRequest !== 'object' || Array.isArray(ctx.formRequest)) {
    fail('ACCESSIBILITY_FORM_REQUEST_REQUIRED', 'Accessible form repair requires the exact source-bound formRequest.', 400);
  }
  if (ctx.formRequest.sourceSha256 !== sourceSha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The accessible-form request is not bound to the supplied source PDF.', 409);
  }
  const service = ctx.accessibilityFormSemantics;
  if (!service || typeof service.repair !== 'function') {
    fail('ACCESSIBILITY_FORM_SERVICE_UNAVAILABLE', 'The production accessible-form semantics service is unavailable.', 503);
  }
  const readArtifact = typeof ctx.readArtifact === 'function'
    ? ctx.readArtifact
    : typeof service.readArtifact === 'function' ? service.readArtifact.bind(service) : null;
  if (!readArtifact) {
    fail('ACCESSIBILITY_FORM_ARTIFACT_READBACK_REQUIRED', 'Accessible form repair requires an explicit artifact reread authority.', 503);
  }
  return { source, sourceSha256, service, readArtifact, request: ctx.formRequest };
}

function validateFormArtifact(receipt, { documentId, sourceSha256, artifactBytes }) {
  const artifact = receipt?.artifact;
  const outputSha256 = sha256(artifactBytes);
  const operation = artifact?.operation;
  if (receipt?.kind !== 'pdf-accessibility-form-semantics' || !receipt.proof
    || !Array.isArray(receipt.limitations) || receipt.limitations.length < 1
    || !artifact || !UUID.test(String(artifact.id ?? '')) || artifact.documentId !== documentId
    || artifact.mediaType !== 'application/pdf' || artifact.size !== artifactBytes.length
    || artifact.sha256 !== outputSha256 || outputSha256 === sourceSha256
    || operation?.type !== 'pdf-accessibility-form-semantics'
    || operation?.validation?.passed !== true || operation.validation.outputSha256 !== outputSha256
    || !Array.isArray(operation.inputs)
    || !operation.inputs.some((input) => input.documentId === documentId
      && input.sha256 === sourceSha256 && input.role === 'source')) {
    fail('ACCESSIBILITY_FORM_RECEIPT_INVALID', 'The accessible-form receipt is not bound to the requested source and reread artifact.', 502);
  }
  return outputSha256;
}

async function productionFormSemantics(ctx) {
  const boundary = formProductionInput(ctx);
  let receipt;
  try {
    receipt = await boundary.service.repair(ctx.documentId, boundary.request, { signal: ctx.signal });
  } catch (error) {
    if (error?.code) throw error;
    fail('ACCESSIBILITY_FORM_SERVICE_FAILED', 'The production accessible-form semantics service failed.', 502);
  }
  let artifactBytes;
  try {
    artifactBytes = requireBytes(await boundary.readArtifact(receipt?.artifact), 'accessibleFormArtifact', { max: 64 * 1024 * 1024 });
  } catch (error) {
    if (error?.code === 'INVALID_PROFESSIONAL_INPUT') {
      fail('ACCESSIBILITY_FORM_RECEIPT_INVALID', 'The accessible-form artifact reread authority did not return bounded PDF bytes.', 502);
    }
    fail('ACCESSIBILITY_FORM_ARTIFACT_READBACK_FAILED', 'The accessible-form artifact could not be reread.', 502);
  }
  const outputSha256 = validateFormArtifact(receipt, {
    documentId: ctx.documentId,
    sourceSha256: boundary.sourceSha256,
    artifactBytes,
  });
  let proof;
  try {
    proof = inspectPdfAccessibilityFormSemantics(boundary.source, artifactBytes, boundary.request);
  } catch {
    fail('ACCESSIBILITY_FORM_OUTPUT_INVALID', 'Independent accessible-form inspection rejected the reread artifact.', 502);
  }
  if (!isDeepStrictEqual(proof, receipt.proof)) {
    fail('ACCESSIBILITY_FORM_RECEIPT_INVALID', 'Independent accessible-form inspection disagreed with the production receipt.', 502);
  }
  return result('accessibility.form-semantics', {
    method: 'production-accessibility-form-semantics-service',
    serviceReceipt: receipt,
    artifact: receipt.artifact,
    limitations: receipt.limitations,
    fields: Object.freeze(boundary.request.fields.map((field) => Object.freeze({ ...field }))),
    count: proof.fieldCount,
    pdf: artifactBytes,
    bytes: artifactBytes.length,
    outputSha256,
    sourceSha256: boundary.sourceSha256,
    applied: true,
    proof,
    demoFixtureUsed: false,
    professionalProof: true,
    trustBoundary: Object.freeze({
      productionService: true,
      immutableSourceDigest: true,
      artifactReread: true,
      independentSemanticInspection: true,
    }),
  });
}

function explicitRepairInput(ctx, requestKey, createDemo) {
  const supplied = ctx.sourcePdf !== undefined || ctx.sourceBytes !== undefined;
  const request = ctx[requestKey];
  if (supplied) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      fail('ACCESSIBILITY_REPAIR_REQUEST_REQUIRED', `Supplied sourcePdf requires ${requestKey}.`, 422);
    }
    return Object.freeze({
      source: requireBytes(ctx.sourcePdf ?? ctx.sourceBytes, 'sourcePdf'),
      request,
      demoFixtureUsed: false,
    });
  }
  if (request !== undefined || ctx.demoFixture !== true) {
    fail('ACCESSIBILITY_REPAIR_SOURCE_REQUIRED', `Accessibility repair requires sourcePdf and ${requestKey}.`, 422);
  }
  const demo = createDemo();
  return Object.freeze({ ...demo, demoFixtureUsed: true });
}

function passiveFormSemanticsPdf(fields) {
  const widgetStart = 5;
  const acroFormObject = widgetStart + fields.length;
  const widgets = fields.map((field, index) => {
    const fieldType = ['Tx', 'text'].includes(field.role) ? 'Tx'
      : ['Btn', 'button'].includes(field.role) ? 'Btn' : 'Ch';
    const top = 700 - index * 24;
    return `<< /Type /Annot /Subtype /Widget /FT /${fieldType} /T (field-${index + 1}) /Rect [72 ${top} 300 ${top + 18}] /P 3 0 R >>`;
  });
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /AcroForm ${acroFormObject} 0 R >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R /Annots [${widgets.map((_, index) => `${widgetStart + index} 0 R`).join(' ')}] >>`,
    '<< /Length 0 >>\nstream\n\nendstream',
    ...widgets,
    `<< /Fields [${widgets.map((_, index) => `${widgetStart + index} 0 R`).join(' ')}] >>`,
  ];
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function formSemanticsRequest(source, fields) {
  const sourceSha256 = sha256(source);
  return {
    profile: PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE,
    sourceSha256,
    fields: fields.map((field, annotationIndex) => {
      const role = ['Tx', 'text'].includes(field.role) ? 'text'
        : ['Btn', 'button'].includes(field.role) ? 'button' : 'choice';
      const fingerprint = createHash('sha256').update(Buffer.from([
        'pdfkit-inspector:opaque-locator:v1', `source-sha256=${sourceSha256}`,
        'page=1', `annotation-index=${annotationIndex}`, 'subtype=widget',
        `widget-type=${role}`,
      ].join('\n'), 'utf8')).digest('hex');
      return {
        target: { page: 1, annotationIndex, fingerprint },
        role,
        name: field.name,
        tooltip: field.tooltip,
        tabIndex: field.tabIndex,
      };
    }),
  };
}

export async function accessibilityFormSemantics(ctx = {}) {
  if (ctx.demoFixture !== true || ctx.sourcePdf !== undefined || ctx.sourceBytes !== undefined
    || ctx.formRequest !== undefined || ctx.accessibilityFormSemantics !== undefined) {
    return productionFormSemantics(ctx);
  }
  const fields = Array.isArray(ctx.fields)
    ? ctx.fields
    : [
      { name: 'Name', role: 'Tx', tooltip: 'Full name', required: true, tabIndex: 0 },
      { name: 'Agree', role: 'Btn', tooltip: 'Consent', required: false, tabIndex: 1 },
    ];
  const normalized = fields.slice(0, 50).map((field, i) => {
    const name = String(field?.name ?? `Field${i + 1}`).slice(0, 80);
    const role = ['Tx', 'Btn', 'Ch', 'text', 'button', 'choice'].includes(field?.role)
      ? field.role
      : 'Tx';
    return Object.freeze({
      name,
      role,
      tooltip: String(field?.tooltip ?? name).slice(0, 120),
      required: field?.required === true,
      tabIndex: Number.isSafeInteger(field?.tabIndex) ? field.tabIndex : i,
      page: Number.isSafeInteger(field?.page) ? field.page : 1,
    });
  });
  const inventorySha256 = createHash('sha256')
    .update(normalized.map((f) => `${f.tabIndex}:${f.name}:${f.role}`).join('|'))
    .digest('hex');
  const repair = explicitRepairInput(ctx, 'formRequest', () => {
    const source = passiveFormSemanticsPdf(normalized);
    return { source, request: formSemanticsRequest(source, normalized) };
  });
  const { source, request } = repair;
  const written = writePdfAccessibilityFormSemantics(source, request);
  const proof = inspectPdfAccessibilityFormSemantics(source, written.bytes, request);
  const pdf = written.bytes;
  return result('accessibility.form-semantics', {
    method: 'local-a11y-form-field-semantics',
    fields: Object.freeze(normalized),
    count: normalized.length,
    requiredCount: normalized.filter((f) => f.required).length,
    inventorySha256,
    pdf,
    bytes: pdf.length,
    outputSha256: sha256(pdf),
    applied: true,
    proof,
    sourceSha256: sha256(source),
    demoFixtureUsed: repair.demoFixtureUsed,
    sourceByteLength: source.length,
    repairRequest: request,
    professionalProof: false,
  });
}
