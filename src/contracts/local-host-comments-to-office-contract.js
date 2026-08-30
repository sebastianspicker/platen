import { PlatenError } from './errors.js';
import { exactObject } from './pdfkit-client-contract-shared.js';

import { OOXML_WORD_MEDIA_TYPE } from './public-wire-identifiers.mjs';

export const COMMENTS_TO_OFFICE_PROFILE = 'local-comments-to-office-text-only-v1';
export const COMMENTS_TO_OFFICE_MEDIA_TYPE = OOXML_WORD_MEDIA_TYPE;
export const COMMENTS_TO_OFFICE_LIMITATIONS = Object.freeze([
  'Text-only DOCX summary; not Word tracked comments or interoperable document review markup.',
  'No source PDF text or bytes, email addresses, HTML, attachments, or annotation geometry are included.',
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_RECORDS = 500;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function contractObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key));
}

function sameList(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validArtifact(value, context) {
  return exactObject(value, [
    'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
  ]) && OPERATION_ID.test(value.id ?? '') && value.documentId === context.documentId
    && typeof value.displayName === 'string' && value.displayName.length >= 1
    && value.displayName.length <= 240 && value.displayName.endsWith('.docx')
    && value.mediaType === COMMENTS_TO_OFFICE_MEDIA_TYPE
    && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 65 * 1024 * 1024
    && SHA256.test(value.sha256 ?? '') && validTimestamp(value.createdAt);
}

function validOperation(value, artifact, context) {
  return exactObject(value, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt',
  ]) && value.schemaVersion === 1 && OPERATION_ID.test(value.id ?? '')
    && value.type === 'comments-to-office' && validTimestamp(value.completedAt)
    && Array.isArray(value.inputs) && value.inputs.length === 1
    && exactObject(value.inputs[0], ['documentId', 'sha256', 'role'])
    && value.inputs[0].documentId === context.documentId
    && value.inputs[0].sha256 === context.sourceSha256
    && value.inputs[0].role === 'source'
    && contractObject(value.parameters, ['profile', 'revision', 'commentSha256', 'commentCount'])
    && value.parameters.profile === COMMENTS_TO_OFFICE_PROFILE
    && value.parameters.revision === context.request.revision
    && value.parameters.commentSha256 === context.result.commentSha256
    && value.parameters.commentCount === context.result.commentCount
    && contractObject(value.expected, ['commentCount', 'textOnly', 'sourceUnchanged', 'reviewInteroperability'])
    && value.expected.commentCount === context.result.commentCount
    && value.expected.textOnly === true
    && value.expected.sourceUnchanged === true
    && value.expected.reviewInteroperability === false
    && contractObject(value.validation, ['passed', 'validators', 'outputSha256'])
    && value.validation.passed === true
    && Array.isArray(value.validation.validators)
    && sameList(value.validation.validators, [
      'source-sha256', 'workspace-read-lease', 'workspace-revision', 'comment-sha256',
      'stored-zip-round-trip', 'docx-text-only-parts', 'artifact-sha256',
    ])
    && value.validation.outputSha256 === artifact.sha256;
}

function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

function copyTree(value) {
  if (Array.isArray(value)) return value.map(copyTree);
  if (!value || typeof value !== 'object') return value;
  const copy = Object.create(Object.getPrototypeOf(value));
  for (const key of Object.keys(value)) copy[key] = copyTree(value[key]);
  return copy;
}

function invalidResult() {
  throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid comments-to-Office result.');
}

export function validateCommentsToOfficeResult(result, context) {
  const request = context?.request;
  const resultContext = { ...context, result };
  if (!exactObject(request, ['sourceSha256', 'revision', 'selectedIds'])
    || !SHA256.test(context?.sourceSha256 ?? '')
    || request.sourceSha256 !== context.sourceSha256
    || !Number.isSafeInteger(request.revision) || request.revision < 0
    || (request.selectedIds !== null && (!Array.isArray(request.selectedIds)
      || request.selectedIds.length < 1 || request.selectedIds.length > MAX_RECORDS
      || request.selectedIds.some((id) => typeof id !== 'string' || !ID.test(id))))) invalidResult();

  if (!exactObject(result, [
    'kind', 'sourceDigest', 'revision', 'commentSha256', 'commentCount', 'artifact', 'limitations', 'localOnly',
  ]) || result.kind !== 'comments-to-office'
    || result.sourceDigest !== context.sourceSha256
    || result.revision !== request.revision
    || !SHA256.test(result.commentSha256 ?? '')
    || !Number.isSafeInteger(result.commentCount) || result.commentCount < 1 || result.commentCount > MAX_RECORDS
    || !sameList(result.limitations, COMMENTS_TO_OFFICE_LIMITATIONS)
    || result.localOnly !== true
    || !validArtifact(result.artifact, context)) invalidResult();

  resultContext.result = result;
  if (!validOperation(result.artifact.operation, result.artifact, resultContext)) invalidResult();
  return freezeTree(copyTree(result));
}
