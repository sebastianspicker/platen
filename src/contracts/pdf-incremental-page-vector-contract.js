import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const INCREMENTAL_PAGE_VECTOR_PROFILE = 'local-incremental-page-vector-v1';
export const INCREMENTAL_PAGE_VECTOR_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-incremental-proof',
  'poppler-page-count-text-boxes', 'poppler-render-target-diff-other-pages-match',
  'pdfsig-output-unsigned', 'artifact-sha256',
]);
export const INCREMENTAL_PAGE_VECTOR_LIMITATIONS = Object.freeze([
  'Only strict, unsigned, unencrypted, passive PDFs with a content-empty target page are accepted.',
  'The operation appends one black 1pt stroked rectangle to the selected page; it is not general vector editing.',
  'Historical source bytes remain present in the append-only revision, and this local evidence does not establish broader semantic or print-production equivalence.',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const RECT_KEYS = Object.freeze(['x', 'y', 'width', 'height']);
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'sourcePrefixPreserved', 'classicIncrementalRevisionAppended',
  'pageCountMatched', 'pageTextMatched', 'pageBoxesMatched',
  'targetPageRenderDiffered', 'otherPageRendersMatched', 'outputUnsigned',
  'artifactDigestBound', 'sourceUnchanged', 'localOnly',
]);

function validRect(value) {
  return exactObject(value, RECT_KEYS)
    && RECT_KEYS.every((key) => Number.isSafeInteger(value[key])
      && Math.abs(value[key]) <= 1_000_000)
    && value.width > 0 && value.height > 0
    && Number.isSafeInteger(value.x + value.width)
    && Number.isSafeInteger(value.y + value.height);
}

function sameRect(left, right) {
  return validRect(left) && validRect(right)
    && RECT_KEYS.every((key) => left[key] === right[key]);
}

function validOperation(operation, artifact, context) {
  return exactObject(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation',
    'completedAt',
  ]) && operation.schemaVersion === 1
    && OPAQUE_ID_PATTERN.test(operation.id ?? '')
    && operation.type === 'pdf-incremental-page-vector'
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256
    && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'page', 'rect'])
    && operation.parameters.profile === INCREMENTAL_PAGE_VECTOR_PROFILE
    && operation.parameters.page === context.request.page
    && sameRect(operation.parameters.rect, context.request.rect)
    && exactObject(operation.expected, [
      'pageCount', 'sourceUnchanged', 'sourcePrefixPreserved', 'classicIncrementalRevisionAppended', 'rasterized',
    ])
    && Number.isSafeInteger(operation.expected.pageCount)
    && operation.expected.pageCount >= 1 && operation.expected.pageCount <= 100
    && operation.expected.sourceUnchanged === true
    && operation.expected.sourcePrefixPreserved === true
    && operation.expected.classicIncrementalRevisionAppended === true
    && operation.expected.rasterized === false
    && exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'outputSha256'])
    && operation.validation.passed === true
    && sameList(operation.validation.validators, INCREMENTAL_PAGE_VECTOR_VALIDATORS)
    && operation.validation.pageCount === operation.expected.pageCount
    && operation.validation.outputSha256 === artifact.sha256;
}

function sameList(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function validArtifact(artifact, context) {
  return exactObject(artifact, [
    'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation',
    'createdAt',
  ])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '')
    && artifact.id !== context.documentId
    && artifact.documentId === context.documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240 && !/[\u0000-\u001f\u007f]/.test(artifact.displayName)
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64
    && artifact.size <= 129 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '')
    && artifact.sha256 !== context.sourceSha256
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}

export function validIncrementalPageVectorRequest(value) {
  return exactObject(value, ['page', 'rect'])
    && Number.isSafeInteger(value.page) && value.page >= 1 && value.page <= 100
    && validRect(value.rect);
}

export function buildIncrementalPageVectorMutation(state) {
  const value = {
    page: Number(state?.selectedPage),
    rect: Object.fromEntries(
      RECT_KEYS.map((key) => [key, Number(state?.incrementalPageVectorRect?.[key])]),
    ),
  };
  if (!validIncrementalPageVectorRequest(value)) {
    throw new Error('Object-preserving page-vector requires one selected page and integer coordinates inside the target rectangle bounds.');
  }
  return Object.freeze({ page: value.page, rect: Object.freeze(value.rect) });
}

function invalidResult() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid source-bound incremental page-vector result.',
  );
}

export function validateIncrementalPageVectorResult(result, context) {
  if (!exactObject(result, ['kind', 'sourceDigest', 'artifact', 'vector', 'evidence', 'limitations'])
    || result.kind !== 'pdf-incremental-page-vector'
    || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context)
    || !exactObject(result.vector, ['page', 'rect'])
    || result.vector.page !== context.request.page
    || !sameRect(result.vector.rect, context.request.rect)
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !sameList(result.limitations, INCREMENTAL_PAGE_VECTOR_LIMITATIONS)
    || !validOperation(result.artifact.operation, result.artifact, context)) {
    invalidResult();
  }
  return result;
}
