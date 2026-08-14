import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_JAVASCRIPT_REMOVAL_PROFILE = 'local-document-javascript-removal-v1';
export const PDF_JAVASCRIPT_REMOVAL_LIMITATIONS = Object.freeze([
  'Classic-xref sources only, with exactly one supported document-level JavaScript locus.',
  'The result is a fresh closed rewrite that prunes prior and unreachable bytes. It is not general PDF sanitization or byte/object/signature preservation.',
]);
export const PDF_JAVASCRIPT_REMOVAL_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-compact-proof',
  'poppler-page-count-text-boxes', 'poppler-render-equality-256px-all-pages',
  'pdfsig-output-unsigned', 'artifact-sha256',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'closedClassicRevision', 'priorRevisionsAbsent',
  'javascriptSurfacesAbsent', 'removedReferencesUnresolvable', 'pageCountMatched',
  'pageTextMatched', 'pageBoxesMatched', 'pageValidationRendersMatched',
  'outputUnsigned', 'artifactDigestBound', 'sourceUnchanged', 'localOnly',
]);

function sameList(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function validArtifact(artifact, context) {
  return exactObject(artifact, [
    'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation',
    'createdAt',
  ]) && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== context.documentId
    && artifact.documentId === context.documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240 && !/[\u0000-\u001f\u007f]/.test(artifact.displayName)
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64
    && artifact.size <= 129 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== context.sourceSha256
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}

function validOperation(operation, artifact, context) {
  const pageCount = operation?.expected?.pageCount;
  return exactObject(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation',
    'completedAt',
  ]) && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '')
    && operation.type === 'pdf-javascript-removal'
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256
    && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile'])
    && operation.parameters.profile === PDF_JAVASCRIPT_REMOVAL_PROFILE
    && exactObject(operation.expected, [
      'pageCount', 'sourceUnchanged', 'closedClassicRevision',
      'priorRevisionsAbsent', 'rasterized',
    ]) && Number.isSafeInteger(pageCount) && pageCount >= 1 && pageCount <= 100
    && operation.expected.sourceUnchanged === true
    && operation.expected.closedClassicRevision === true
    && operation.expected.priorRevisionsAbsent === true
    && operation.expected.rasterized === false
    && exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'outputSha256'])
    && operation.validation.passed === true
    && sameList(operation.validation.validators, PDF_JAVASCRIPT_REMOVAL_VALIDATORS)
    && operation.validation.pageCount === pageCount
    && operation.validation.outputSha256 === artifact.sha256;
}

function invalidResult() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid source-bound JavaScript-removal result.',
  );
}

export function validatePdfJavaScriptRemovalResult(result, context) {
  if (!exactObject(result, [
    'kind', 'sourceDigest', 'artifact', 'removal', 'evidence', 'limitations',
  ]) || result.kind !== 'pdf-javascript-removal'
    || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context)
    || !exactObject(result.removal, ['profile', 'removedLocus'])
    || result.removal.profile !== PDF_JAVASCRIPT_REMOVAL_PROFILE
    || !['open-action', 'names'].includes(result.removal.removedLocus)
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !sameList(result.limitations, PDF_JAVASCRIPT_REMOVAL_LIMITATIONS)
    || !validOperation(result.artifact.operation, result.artifact, context)) invalidResult();
  return result;
}
