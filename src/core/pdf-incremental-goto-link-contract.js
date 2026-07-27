import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const INCREMENTAL_GOTO_LINK_PROFILE = 'local-incremental-goto-link-v1';
export const INCREMENTAL_GOTO_LINK_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-incremental-proof',
  'poppler-page-count-text-boxes', 'poppler-render-equality-256px-all-pages',
  'pdfsig-output-unsigned', 'artifact-sha256',
]);
export const INCREMENTAL_GOTO_LINK_LIMITATIONS = Object.freeze([
  'Only bounded classic or admitted xref/object-stream sources with fixed control filters are accepted. Every leaf needs explicit integer MediaBox and CropBox containment.',
  'Existing annotations are limited to a passive whitelist with no links or actions; the new annotation is one direct /Dest /Fit link. This is not general hyperlink support or sanitization.',
  'A classic append-only revision is added. Historical source bytes remain present; this does not preserve signatures or establish broader semantic or print-production equivalence.',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const RECT_KEYS = Object.freeze(['left', 'bottom', 'right', 'top']);
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'sourcePrefixPreserved',
  'classicIncrementalRevisionAppended', 'pageCountMatched', 'pageTextMatched',
  'pageBoxesMatched', 'pageValidationRendersMatched', 'outputUnsigned',
  'artifactDigestBound', 'sourceUnchanged', 'localOnly',
]);

function validRect(rect) {
  return exactObject(rect, RECT_KEYS)
    && RECT_KEYS.every((key) => Number.isSafeInteger(rect[key])
      && Math.abs(rect[key]) <= 1_000_000)
    && rect.left < rect.right && rect.bottom < rect.top;
}

function sameRect(left, right) {
  return validRect(left) && validRect(right)
    && RECT_KEYS.every((key) => left[key] === right[key]);
}

function inspectedSourceCropBox(state, page) {
  const record = state?.analysis?.structure?.pageBoxes?.find(
    (entry) => entry?.page === page,
  );
  const box = record?.boxes?.cropBox;
  return box && ['left', 'bottom', 'right', 'top'].every(
    (key) => Number.isFinite(box[key]),
  ) && box.left < box.right && box.bottom < box.top ? box : null;
}

function containsRect(box, rect) {
  return box?.left <= rect.left && box?.bottom <= rect.bottom
    && box?.right >= rect.right && box?.top >= rect.top;
}

export function incrementalGoToLinkRequestFitsInspectedCropBox(state, request) {
  return validIncrementalGoToLinkRequest(request)
    && containsRect(inspectedSourceCropBox(state, request.sourcePage), request.rect);
}

export function validIncrementalGoToLinkRequest(value) {
  return exactObject(value, ['sourcePage', 'targetPage', 'rect'])
    && [value.sourcePage, value.targetPage].every(
      (page) => Number.isSafeInteger(page) && page >= 1 && page <= 100,
    ) && validRect(value.rect);
}

export function buildIncrementalGoToLinkMutation(state) {
  const x = Number(state?.pdfkitLinkRect?.x);
  const y = Number(state?.pdfkitLinkRect?.y);
  const width = Number(state?.pdfkitLinkRect?.width);
  const height = Number(state?.pdfkitLinkRect?.height);
  const request = {
    sourcePage: Number(state?.selectedPage),
    targetPage: Number(state?.pdfkitLinkTargetPage),
    rect: { left: x, bottom: y, right: x + width, top: y + height },
  };
  const pageCount = state?.analysis?.inspection?.pageCount;
  const cropBox = inspectedSourceCropBox(state, request.sourcePage);
  if (!validIncrementalGoToLinkRequest(request)
    || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100
    || request.sourcePage > pageCount || request.targetPage > pageCount
    || !containsRect(cropBox, request.rect)) {
    throw new Error('Object-preserving local link requires existing pages and an integer PDF rectangle.');
  }
  return Object.freeze({
    sourcePage: request.sourcePage, targetPage: request.targetPage,
    rect: Object.freeze(request.rect),
  });
}

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
    && operation.type === 'pdf-incremental-goto-link'
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256
    && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'sourcePage', 'targetPage', 'rect'])
    && operation.parameters.profile === INCREMENTAL_GOTO_LINK_PROFILE
    && operation.parameters.sourcePage === context.request.sourcePage
    && operation.parameters.targetPage === context.request.targetPage
    && sameRect(operation.parameters.rect, context.request.rect)
    && exactObject(operation.expected, [
      'pageCount', 'sourceUnchanged', 'sourcePrefixPreserved',
      'classicIncrementalRevisionAppended', 'rasterized',
    ]) && Number.isSafeInteger(pageCount) && pageCount >= 1 && pageCount <= 100
    && context.request.sourcePage <= pageCount && context.request.targetPage <= pageCount
    && operation.expected.sourceUnchanged === true
    && operation.expected.sourcePrefixPreserved === true
    && operation.expected.classicIncrementalRevisionAppended === true
    && operation.expected.rasterized === false
    && exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'outputSha256'])
    && operation.validation.passed === true
    && sameList(operation.validation.validators, INCREMENTAL_GOTO_LINK_VALIDATORS)
    && operation.validation.pageCount === pageCount
    && operation.validation.outputSha256 === artifact.sha256;
}

function invalidResult() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid source-bound incremental GoTo-link result.',
  );
}

export function validateIncrementalGoToLinkResult(result, context) {
  if (!exactObject(result, [
    'kind', 'sourceDigest', 'artifact', 'link', 'evidence', 'limitations',
  ]) || result.kind !== 'pdf-incremental-goto-link'
    || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context)
    || !exactObject(result.link, ['sourcePage', 'targetPage', 'rect'])
    || result.link.sourcePage !== context.request.sourcePage
    || result.link.targetPage !== context.request.targetPage
    || !sameRect(result.link.rect, context.request.rect)
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !sameList(result.limitations, INCREMENTAL_GOTO_LINK_LIMITATIONS)
    || !validOperation(result.artifact.operation, result.artifact, context)) invalidResult();
  return result;
}
