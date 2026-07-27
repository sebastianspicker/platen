import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const INCREMENTAL_BLEED_BOX_PROFILE = 'local-classic-incremental-bleed-box-v1';
export const INCREMENTAL_BLEED_BOX_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'classic-xref-proof',
  'poppler-page-count', 'poppler-page-text', 'poppler-page-boxes',
  'poppler-render-equality-256px-all-pages', 'pdfsig-output-unsigned', 'xmp-absent',
  'source-unchanged', 'artifact-sha256',
]);
export const INCREMENTAL_BLEED_BOX_LIMITATIONS = Object.freeze([
  'Only the supported bounded xref subset is accepted; admitted xref/object streams may use the fixed control-filter pipelines, while encrypted, signed, form, JavaScript, XMP, attachment, and URL-bearing PDFs are rejected.',
  'The output is a structure-preserving append-only revision: prior source bytes remain exactly present and the selected page object is revised in place.',
  'Validation establishes fixed 256-pixel-long-edge Poppler PNG byte equality for every page, not broader visual, semantic, or print-production equivalence.',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const RECT_KEYS = Object.freeze(['x', 'y', 'width', 'height']);
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'sourcePrefixPreserved', 'onlyTargetBleedBoxChanged',
  'samePageObjectRevision', 'classicIncrementalRevisionAppended',
  'pageCountMatched', 'pageTextMatched', 'nonTargetPageBoxesMatched',
  'selectedMediaCropTrimArtMatched', 'selectedBleedBoxMatched',
  'pageValidationRendersMatched', 'outputUnsigned', 'xmpAbsent', 'artifactDigestBound',
  'sourceUnchanged', 'localOnly',
]);

function validRect(rect) {
  return exactObject(rect, RECT_KEYS)
    && RECT_KEYS.every((key) => Number.isSafeInteger(rect[key])
      && Math.abs(rect[key]) <= 1_000_000)
    && rect.width > 0 && rect.height > 0
    && Number.isSafeInteger(rect.x + rect.width)
    && Number.isSafeInteger(rect.y + rect.height);
}

function sameRect(left, right) {
  return validRect(left) && validRect(right)
    && RECT_KEYS.every((key) => left[key] === right[key]);
}

export function validIncrementalBleedBoxRequest(value) {
  return exactObject(value, ['page', 'rect'])
    && Number.isSafeInteger(value.page) && value.page >= 1 && value.page <= 100
    && validRect(value.rect);
}

export function buildIncrementalBleedBoxMutation(state) {
  const value = {
    page: Number(state?.selectedPage),
    rect: Object.fromEntries(RECT_KEYS.map(
      (key) => [key, Number(state?.pdfkitPageBoxRect?.[key])],
    )),
  };
  if (state?.pdfkitPageBox !== 'bleed' || !validIncrementalBleedBoxRequest(value)) {
    throw new Error('Object-preserving BleedBox requires one selected page and integer coordinates within the local bounds.');
  }
  return Object.freeze({ page: value.page, rect: Object.freeze(value.rect) });
}

function validArtifact(artifact, context) {
  return exactObject(artifact, [
    'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
  ])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== context.documentId
    && artifact.documentId === context.documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240 && !/[\u0000-\u001f\u007f]/.test(artifact.displayName)
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64
    && artifact.size <= 129 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== context.sourceSha256
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}

function sameList(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function validOperation(operation, artifact, context) {
  const pageCount = operation?.expected?.pageCount;
  return exactObject(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation',
    'completedAt',
  ])
    && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '')
    && operation.type === 'pdf-incremental-bleed-box'
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256
    && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'page', 'rect'])
    && operation.parameters.profile === INCREMENTAL_BLEED_BOX_PROFILE
    && operation.parameters.page === context.request.page
    && sameRect(operation.parameters.rect, context.request.rect)
    && exactObject(operation.expected, [
      'pageCount', 'sourceUnchanged', 'sourcePrefixPreserved',
      'samePageObjectRevision', 'rasterized',
    ])
    && Number.isSafeInteger(pageCount) && pageCount >= 1 && pageCount <= 100
    && operation.expected.sourceUnchanged === true
    && operation.expected.sourcePrefixPreserved === true
    && operation.expected.samePageObjectRevision === true
    && operation.expected.rasterized === false
    && exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'outputSha256'])
    && operation.validation.passed === true
    && sameList(operation.validation.validators, INCREMENTAL_BLEED_BOX_VALIDATORS)
    && operation.validation.pageCount === pageCount
    && operation.validation.outputSha256 === artifact.sha256;
}

function invalidResult() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid source-bound incremental BleedBox result.',
  );
}

export function validateIncrementalBleedBoxResult(result, context) {
  if (!exactObject(result, [
    'kind', 'sourceDigest', 'artifact', 'pageBox', 'evidence', 'limitations',
  ])
    || result.kind !== 'pdf-incremental-bleed-box'
    || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context)
    || !exactObject(result.pageBox, ['profile', 'page', 'rect'])
    || result.pageBox.profile !== INCREMENTAL_BLEED_BOX_PROFILE
    || result.pageBox.page !== context.request.page
    || !sameRect(result.pageBox.rect, context.request.rect)
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !sameList(result.limitations, INCREMENTAL_BLEED_BOX_LIMITATIONS)
    || !validOperation(result.artifact.operation, result.artifact, context)) invalidResult();
  return result;
}
