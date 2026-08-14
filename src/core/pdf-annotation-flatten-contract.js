import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const ANNOTATION_FLATTEN_PROFILE = 'local-square-annotation-flatten-v1';
export const ANNOTATION_FLATTEN_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-locator-appearance-compact-proof',
  'poppler-page-count-text-boxes', 'poppler-render-equality-256px-all-pages',
  'pdfsig-output-unsigned', 'artifact-sha256',
]);
export const ANNOTATION_FLATTEN_LIMITATIONS = Object.freeze([
  'Only one source-bound /Square annotation in the entire bounded document is accepted. It must have the Print flag and one tiny, unfiltered, resource-free normal appearance stream.',
  'The selected page must be unrotated and use direct page resources without existing XObjects. Appearance state dictionaries, widgets, actions, popups, filters, resources, groups, optional content, and unsupported graphs fail closed.',
  'The result is a fresh closed rewrite that promotes the admitted appearance into page content and removes prior revisions and the annotation object. It is not general annotation flattening, sanitization, or signature preservation.',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'locatorRederived', 'normalAppearanceVerified',
  'appearancePromotedToPageContent', 'annotationRemoved',
  'removedReferenceUnresolvable', 'closedClassicRevision', 'priorRevisionsAbsent',
  'pageCountMatched', 'pageTextMatched', 'pageBoxesMatched',
  'pageValidationRendersMatched', 'outputUnsigned', 'artifactDigestBound',
  'sourceUnchanged', 'localOnly',
]);

export function validAnnotationFlattenTarget(value) {
  return exactObject(value, ['page', 'annotationIndex', 'fingerprint', 'subtype'])
    && Number.isSafeInteger(value.page) && value.page >= 1 && value.page <= 100
    && value.annotationIndex === 0 && SHA256.test(value.fingerprint ?? '')
    && value.subtype === 'square';
}

export function buildAnnotationFlattenMutation(state) {
  const inspection = state?.pdfkitInspectionResult;
  const pageNumber = Number(state?.selectedPage);
  const page = inspection?.pages?.find((entry) => entry.index === pageNumber);
  const annotationIndex = Number(state?.pdfkitExistingAnnotationIndex);
  const annotation = page?.annotations?.find((entry) => entry.annotationIndex === annotationIndex);
  const allAnnotations = inspection?.pages?.flatMap((entry) => (
    entry.annotationsTruncated === false ? entry.annotations ?? [] : [null]
  ));
  const target = {
    page: pageNumber,
    annotationIndex,
    fingerprint: annotation?.fingerprint,
    subtype: annotation?.subtype,
  };
  if (inspection?.sourceDigest !== state?.analysis?.sha256
    || inspection?.pageCount !== state?.analysis?.inspection?.pageCount
    || !Array.isArray(allAnnotations) || allAnnotations.length !== 1
    || allAnnotations[0] !== annotation || !validAnnotationFlattenTarget(target)) {
    throw new Error('Flattening requires the sole inspected annotation to be a source-bound square annotation at index 0.');
  }
  return Object.freeze({ target: Object.freeze(target) });
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
    && artifact.size <= 512 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== context.sourceSha256
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}

function validOperation(operation, artifact, context) {
  const { target } = context.request;
  const pageCount = operation?.expected?.pageCount;
  return exactObject(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation',
    'completedAt',
  ]) && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '')
    && operation.type === 'pdf-square-annotation-flatten'
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256
    && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'page', 'annotationIndex', 'subtype'])
    && operation.parameters.profile === ANNOTATION_FLATTEN_PROFILE
    && operation.parameters.page === target.page
    && operation.parameters.annotationIndex === target.annotationIndex
    && operation.parameters.subtype === target.subtype
    && exactObject(operation.expected, [
      'pageCount', 'flattenedAnnotationCount', 'sourceUnchanged',
      'closedClassicRevision', 'priorRevisionsAbsent', 'rasterized',
    ]) && Number.isSafeInteger(pageCount) && pageCount >= 1 && pageCount <= 100
    && target.page <= pageCount && operation.expected.flattenedAnnotationCount === 1
    && operation.expected.sourceUnchanged === true
    && operation.expected.closedClassicRevision === true
    && operation.expected.priorRevisionsAbsent === true
    && operation.expected.rasterized === false
    && exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'outputSha256'])
    && operation.validation.passed === true
    && sameList(operation.validation.validators, ANNOTATION_FLATTEN_VALIDATORS)
    && operation.validation.pageCount === pageCount
    && operation.validation.outputSha256 === artifact.sha256;
}

function invalidResult() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid source-bound annotation-flatten result.',
  );
}

export function validateAnnotationFlattenResult(result, context) {
  const target = context?.request?.target;
  if (!validAnnotationFlattenTarget(target) || !SHA256.test(context?.sourceSha256 ?? '')
    || !exactObject(result, ['kind', 'sourceDigest', 'artifact', 'flatten', 'evidence', 'limitations'])
    || result.kind !== 'pdf-square-annotation-flatten'
    || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context)
    || !exactObject(result.flatten, ['profile', 'page', 'annotationIndex', 'subtype'])
    || result.flatten.profile !== ANNOTATION_FLATTEN_PROFILE
    || result.flatten.page !== target.page
    || result.flatten.annotationIndex !== target.annotationIndex
    || result.flatten.subtype !== target.subtype
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !sameList(result.limitations, ANNOTATION_FLATTEN_LIMITATIONS)
    || !validOperation(result.artifact.operation, result.artifact, context)) invalidResult();
  return result;
}
