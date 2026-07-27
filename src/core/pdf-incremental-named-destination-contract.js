import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const INCREMENTAL_NAMED_DESTINATION_PROFILE = 'local-incremental-named-destination-v1';
export const INCREMENTAL_NAMED_DESTINATION_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-incremental-proof',
  'poppler-named-destination-before-after', 'poppler-page-count-text-boxes',
  'poppler-render-equality-256px-all-pages', 'pdfsig-output-unsigned',
  'artifact-sha256',
]);
export const INCREMENTAL_NAMED_DESTINATION_LIMITATIONS = Object.freeze([
  'Only bounded classic or admitted xref/object-stream sources with no existing name tree or legacy destinations are accepted.',
  'Exactly one 1-64 character ASCII name is added with a direct local /Fit target. Page annotations, actions, forms, signatures, active content, and unsupported graphs fail closed.',
  'A classic append-only revision is added. Historical source bytes remain present; this is not general destination management, sanitization, or signature preservation.',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'sourcePrefixPreserved',
  'classicIncrementalRevisionAppended', 'namedDestinationAbsentBefore',
  'namedDestinationMatched', 'pageCountMatched', 'pageTextMatched',
  'pageBoxesMatched', 'pageValidationRendersMatched', 'outputUnsigned',
  'artifactDigestBound', 'sourceUnchanged', 'localOnly',
]);

export function validIncrementalNamedDestinationRequest(value) {
  return exactObject(value, ['targetPage', 'name'])
    && Number.isSafeInteger(value.targetPage)
    && value.targetPage >= 1 && value.targetPage <= 100
    && typeof value.name === 'string' && NAME.test(value.name);
}

export function buildIncrementalNamedDestinationMutation(state) {
  const request = {
    targetPage: Number(state?.incrementalNamedDestinationTargetPage),
    name: String(state?.incrementalNamedDestinationName ?? ''),
  };
  const pageCount = state?.analysis?.inspection?.pageCount;
  if (!validIncrementalNamedDestinationRequest(request)
    || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100
    || request.targetPage > pageCount) {
    throw new Error('Named destination requires an existing page and a 1-64 character ASCII name using letters, numbers, dot, underscore, or hyphen.');
  }
  return Object.freeze(request);
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
    && operation.type === 'pdf-incremental-named-destination'
    && typeof operation.completedAt === 'string'
    && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256
    && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'targetPage', 'nameSha256'])
    && operation.parameters.profile === INCREMENTAL_NAMED_DESTINATION_PROFILE
    && operation.parameters.targetPage === context.request.targetPage
    && operation.parameters.nameSha256 === context.nameSha256
    && exactObject(operation.expected, [
      'pageCount', 'namedDestinationAdded', 'sourceUnchanged', 'sourcePrefixPreserved',
      'classicIncrementalRevisionAppended', 'rasterized',
    ]) && Number.isSafeInteger(pageCount) && pageCount >= 1 && pageCount <= 100
    && context.request.targetPage <= pageCount
    && operation.expected.namedDestinationAdded === true
    && operation.expected.sourceUnchanged === true
    && operation.expected.sourcePrefixPreserved === true
    && operation.expected.classicIncrementalRevisionAppended === true
    && operation.expected.rasterized === false
    && exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'outputSha256'])
    && operation.validation.passed === true
    && sameList(operation.validation.validators, INCREMENTAL_NAMED_DESTINATION_VALIDATORS)
    && operation.validation.pageCount === pageCount
    && operation.validation.outputSha256 === artifact.sha256;
}

function invalidResult() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid source-bound named-destination result.',
  );
}

export function validateIncrementalNamedDestinationResult(result, context) {
  if (!validIncrementalNamedDestinationRequest(context.request)
    || !SHA256.test(context.nameSha256 ?? '')
    || !exactObject(result, [
      'kind', 'sourceDigest', 'artifact', 'destination', 'evidence', 'limitations',
    ]) || result.kind !== 'pdf-incremental-named-destination'
    || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context)
    || !exactObject(result.destination, ['profile', 'targetPage', 'nameSha256', 'fit'])
    || result.destination.profile !== INCREMENTAL_NAMED_DESTINATION_PROFILE
    || result.destination.targetPage !== context.request.targetPage
    || result.destination.nameSha256 !== context.nameSha256
    || result.destination.fit !== true
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !sameList(result.limitations, INCREMENTAL_NAMED_DESTINATION_LIMITATIONS)
    || !validOperation(result.artifact.operation, result.artifact, context)) invalidResult();
  return result;
}
