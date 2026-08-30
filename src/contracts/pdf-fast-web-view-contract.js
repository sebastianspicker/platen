import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_FAST_WEB_VIEW_PROFILE = 'local-pdf-fast-web-view-v1';
export const PDF_FAST_WEB_VIEW_LIMITATIONS = Object.freeze([
  'The output is linearized only when qpdf independently accepts its linearization dictionary and hint tables.',
  'Linearization evidence does not guarantee delivery behavior for every HTTP server, cache, or PDF consumer.',
  'The immutable source remains unchanged; the result is a separate derived artifact.',
]);
export const PDF_FAST_WEB_VIEW_VALIDATORS = Object.freeze([
  'source-sha256', 'private-workspace', 'qpdf-linearize',
  'qpdf-check-linearization', 'linearization-dictionary', 'artifact-sha256',
]);

const SHA256 = /^[0-9a-f]{64}$/u;

function invalid() {
  throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid source-bound fast-web-view result.');
}

function validArtifact(artifact, context) {
  return exactObject(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== context.documentId
    && artifact.documentId === context.documentId && typeof artifact.displayName === 'string'
    && artifact.displayName.length > 0 && artifact.displayName.length <= 240
    && !/[\u0000-\u001f\u007f]/u.test(artifact.displayName) && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64 && artifact.size <= 512 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '')
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}

export function validatePdfFastWebViewResult(result, context) {
  if (!exactObject(result, ['kind', 'sourceDigest', 'artifact', 'engine', 'evidence', 'limitations'])
    || result.kind !== 'pdf-fast-web-view' || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context)
    || !exactObject(result.engine, ['name', 'version']) || result.engine.name !== 'qpdf'
    || typeof result.engine.version !== 'string' || !/^\d+(?:\.\d+){1,3}$/u.test(result.engine.version)
    || !exactObject(result.evidence, ['sourceDigestReverified', 'qpdfLinearized', 'qpdfCheckLinearization', 'linearizationDictionaryValid', 'artifactDigestBound', 'sourceUnchanged', 'localOnly'])
    || Object.values(result.evidence).some((value) => value !== true)
    || !Array.isArray(result.limitations) || result.limitations.length !== PDF_FAST_WEB_VIEW_LIMITATIONS.length
    || result.limitations.some((value, index) => value !== PDF_FAST_WEB_VIEW_LIMITATIONS[index])
    || !exactObject(result.artifact.operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    || result.artifact.operation.schemaVersion !== 1
    || result.artifact.operation.type !== 'pdf-fast-web-view'
    || !OPAQUE_ID_PATTERN.test(result.artifact.operation.id ?? '')
    || !Array.isArray(result.artifact.operation.inputs) || result.artifact.operation.inputs.length !== 1
    || !exactObject(result.artifact.operation.inputs[0], ['documentId', 'sha256', 'role'])
    || result.artifact.operation.inputs[0].documentId !== context.documentId
    || result.artifact.operation.inputs[0].sha256 !== context.sourceSha256
    || result.artifact.operation.inputs[0].role !== 'source'
    || !exactObject(result.artifact.operation.parameters, ['profile'])
    || result.artifact.operation.parameters.profile !== PDF_FAST_WEB_VIEW_PROFILE
    || !exactObject(result.artifact.operation.expected, ['linearized', 'sourceUnchanged', 'pageRangeDelivery'])
    || result.artifact.operation.expected.linearized !== true
    || result.artifact.operation.expected.sourceUnchanged !== true
    || result.artifact.operation.expected.pageRangeDelivery !== 'not-proven'
    || !exactObject(result.artifact.operation.validation, ['passed', 'validators', 'linearized', 'linearizationLength', 'outputSha256'])
    || result.artifact.operation.validation.passed !== true
    || result.artifact.operation.validation.linearized !== true
    || !Number.isSafeInteger(result.artifact.operation.validation.linearizationLength)
    || JSON.stringify(result.artifact.operation.validation.validators) !== JSON.stringify(PDF_FAST_WEB_VIEW_VALIDATORS)
    || result.artifact.operation.validation.outputSha256 !== result.artifact.sha256
    || typeof result.artifact.operation.completedAt !== 'string' || Number.isNaN(Date.parse(result.artifact.operation.completedAt))) invalid();
  return result;
}
