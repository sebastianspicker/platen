import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const INCREMENTAL_PAGE_TRANSITION_PROFILE = 'local-classic-incremental-page-transition-v1';
export const INCREMENTAL_PAGE_TRANSITION_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'classic-single-revision-proof',
  'raw-transition-reinspection', 'page-topology-preserved',
  'page-content-boxes-resources-annotations-preserved', 'artifact-sha256',
]);
export const INCREMENTAL_PAGE_TRANSITION_LIMITATIONS = Object.freeze([
  'Only one classic, single-revision, unencrypted, unsigned, non-compressed PDF revision is accepted.',
  'Only the PDF /Dissolve transition profile is authored; page display duration, viewer-specific behavior, and other transition styles are not supported.',
  'The operation appends a revision and changes only selected page dictionaries by adding /Trans. Historical source bytes remain present and this is not signature preservation or broad viewer equivalence.',
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'sourcePrefixPreserved', 'rawReinspectionPassed',
  'pageTopologyPreserved', 'pageContentBoxesResourcesAnnotationsPreserved',
  'onlySelectedPagesChanged', 'artifactDigestBound', 'sourceUnchanged', 'localOnly',
]);

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function plainArray(value, maximum = 100) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length >= 1 && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, String(index))).every(Boolean)
    && Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) => (
      !descriptor.get && !descriptor.set && (key === 'length' ? descriptor.enumerable === false : descriptor.enumerable === true)
    ));
}

function pagesValid(pages) {
  return plainArray(pages) && pages.every((page, index) => Number.isSafeInteger(page)
    && page >= 1 && page <= 100 && (index === 0 || page > pages[index - 1]));
}

function samePages(left, right) {
  return pagesValid(left) && pagesValid(right) && left.length === right.length
    && left.every((page, index) => page === right[index]);
}

export function validIncrementalPageTransitionRequest(value) {
  return exactObject(value, ['pages', 'transition', 'duration'])
    && pagesValid(value.pages) && value.transition === 'Dissolve'
    && typeof value.duration === 'number' && Number.isFinite(value.duration)
    && value.duration >= 0 && value.duration <= 60
    && value.duration * 1000 === Math.round(value.duration * 1000);
}

function invalidResult() {
  throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid source-bound page-transition result.');
}

function validArtifact(artifact, context) {
  return exactObject(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== context.documentId
    && artifact.documentId === context.documentId && artifact.mediaType === 'application/pdf'
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(artifact.displayName)
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64 && artifact.size <= 129 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== context.sourceSha256
    && canonicalTimestamp(artifact.createdAt);
}

function validOperation(operation, artifact, context) {
  return exactObject(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    && operation.schemaVersion === 1 && UUID.test(operation.id ?? '')
    && operation.type === 'pdf-incremental-page-transition'
    && canonicalTimestamp(operation.completedAt)
    && plainArray(operation.inputs, 1) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256 && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'pages', 'transition', 'duration'])
    && operation.parameters.profile === INCREMENTAL_PAGE_TRANSITION_PROFILE
    && samePages(operation.parameters.pages, context.request.pages)
    && operation.parameters.transition === context.request.transition
    && operation.parameters.duration === context.request.duration
    && exactObject(operation.expected, ['selectedPages', 'sourceUnchanged', 'sourcePrefixPreserved', 'onlySelectedPagesChanged', 'pageDictionariesPreserved', 'rasterized'])
    && samePages(operation.expected.selectedPages, context.request.pages)
    && operation.expected.sourceUnchanged === true && operation.expected.sourcePrefixPreserved === true
    && operation.expected.onlySelectedPagesChanged === true && operation.expected.pageDictionariesPreserved === true
    && operation.expected.rasterized === false
    && exactObject(operation.validation, ['passed', 'validators', 'outputSha256', 'profile'])
    && operation.validation.passed === true
    && operation.validation.outputSha256 === artifact.sha256
    && operation.validation.profile === INCREMENTAL_PAGE_TRANSITION_PROFILE
    && Array.isArray(operation.validation.validators)
    && operation.validation.validators.length === INCREMENTAL_PAGE_TRANSITION_VALIDATORS.length
    && operation.validation.validators.every((value, index) => value === INCREMENTAL_PAGE_TRANSITION_VALIDATORS[index]);
}

export function validateIncrementalPageTransitionResult(result, context) {
  if (!exactObject(result, ['kind', 'sourceDigest', 'artifact', 'transition', 'evidence', 'limitations'])
    || result.kind !== 'pdf-incremental-page-transition' || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context)
    || !exactObject(result.transition, ['pages', 'style', 'duration'])
    || !samePages(result.transition.pages, context.request.pages)
    || result.transition.style !== context.request.transition || result.transition.duration !== context.request.duration
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !Array.isArray(result.limitations) || result.limitations.length !== INCREMENTAL_PAGE_TRANSITION_LIMITATIONS.length
    || result.limitations.some((value, index) => value !== INCREMENTAL_PAGE_TRANSITION_LIMITATIONS[index])
    || !validOperation(result.artifact.operation, result.artifact, context)) invalidResult();
  return freezeResult(result);
}

function freezeResult(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeResult);
  return Object.freeze(value);
}
