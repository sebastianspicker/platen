import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
import { expectedPdfKitMutationResult } from './pdfkit-client-mutation-result-expectations.js';

const DIGEST = /^[0-9a-f]{64}$/;
const ARTIFACT_KEYS = Object.freeze([
  'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
]);
const OPERATION_KEYS = Object.freeze([
  'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation',
  'completedAt',
]);
const BASE_VALIDATION_KEYS = Object.freeze([
  'passed', 'validators', 'pageCount', 'renderedPages', 'appliedEdits', 'outputSha256',
]);

function sameJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => sameJson(entry, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left); const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]),
  );
}

function validArtifact(artifact, documentId, sourceSha256) {
  return exactObject(artifact, ARTIFACT_KEYS)
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== documentId
    && artifact.documentId === documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240 && !/[\u0000-\u001f\u007f]/.test(artifact.displayName)
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 1
    && artifact.size <= 256 * 1024 * 1024
    && DIGEST.test(artifact.sha256 ?? '') && artifact.sha256 !== sourceSha256
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}

function expectedValidationKeys(expected) {
  return [
    ...BASE_VALIDATION_KEYS,
    ...(expected.rotation ? ['rotatedPage', 'pageRotation'] : []),
    ...(expected.pageBox?.box === 'crop' ? ['croppedPage', 'persistentCropBox'] : []),
    ...(expected.pageBox?.box === 'bleed' ? ['bleedBoxPage', 'persistentBleedBox'] : []),
  ];
}

function validValidation(validation, artifact, expected, pageCount) {
  return exactObject(validation, expectedValidationKeys(expected))
    && validation.passed === true
    && sameJson(validation.validators, expected.validators)
    && validation.pageCount === pageCount && validation.renderedPages === pageCount
    && validation.appliedEdits === expected.editCount
    && validation.outputSha256 === artifact.sha256
    && (!expected.rotation || (
      validation.rotatedPage === expected.rotation.page
      && validation.pageRotation === expected.rotation.degrees
    ))
    && (expected.pageBox?.box !== 'crop' || (
      validation.croppedPage === expected.pageBox.page
      && sameJson(validation.persistentCropBox, expected.pageBox.rect)
    ))
    && (expected.pageBox?.box !== 'bleed' || (
      validation.bleedBoxPage === expected.pageBox.page
      && sameJson(validation.persistentBleedBox, expected.pageBox.rect)
    ));
}

function validOperation(operation, artifact, context, expected) {
  const pageCount = operation?.expected?.pageCount;
  return exactObject(operation, OPERATION_KEYS)
    && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '')
    && operation.type === expected.type
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256
    && operation.inputs[0].role === 'source'
    && sameJson(operation.parameters, expected.parameters)
    && exactObject(operation.expected, ['pageCount', 'rasterized', 'editCount'])
    && Number.isSafeInteger(pageCount) && pageCount >= 1 && pageCount <= 100
    && operation.expected.rasterized === false
    && operation.expected.editCount === expected.editCount
    && validValidation(operation.validation, artifact, expected, pageCount);
}

function invalid() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid source-bound PDFKit mutation result.',
  );
}

export function validatePdfKitMutationResult(result, context) {
  const expected = expectedPdfKitMutationResult(context.profile, context.mutation);
  if (!exactObject(result, [
    'kind', 'sourceDigest', 'artifact', 'appliedEdits', 'postflight', 'evidence',
    'limitations',
  ])
    || result.kind !== expected.kind || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context.documentId, context.sourceSha256)
    || result.appliedEdits !== expected.editCount
    || !result.postflight || typeof result.postflight !== 'object'
    || Array.isArray(result.postflight)
    || !sameJson(result.evidence, expected.evidence)
    || !Array.isArray(result.limitations) || result.limitations.length !== 3
    || result.limitations.some((entry) => typeof entry !== 'string'
      || entry.length < 1 || entry.length > 1_024)
    || !validOperation(result.artifact.operation, result.artifact, context, expected)) invalid();
  return result;
}
