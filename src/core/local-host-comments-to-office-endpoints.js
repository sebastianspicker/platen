import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const COMMENTS_TO_OFFICE_PROFILE = 'local-comments-to-office-text-only-v1';
export const COMMENTS_TO_OFFICE_LIMITATIONS = Object.freeze([
  'Text-only DOCX summary; not Word tracked comments or interoperable document review markup.',
  'No source PDF text or bytes, email addresses, HTML, attachments, or annotation geometry are included.',
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
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
    && value.mediaType === DOCX_MEDIA_TYPE
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
  return freezeTree(structuredClone(result));
}

function validSelectedIds(value) {
  if (value === null) return true;
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_RECORDS
    && Object.keys(value).length === value.length
    && value.every((id) => typeof id === 'string' && ID.test(id))
    && new Set(value).size === value.length;
}

export function createCommentsToOfficeEndpoints({ json }) {
  return Object.freeze({
    exportCommentsToOffice(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '')
        || !exactObject(request, ['sourceSha256', 'revision', 'selectedIds'])
        || !SHA256.test(request.sourceSha256 ?? '')
        || !Number.isSafeInteger(request.revision) || request.revision < 0
        || !validSelectedIds(request.selectedIds)
        || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Comments-to-Office options are invalid.');
      }
      const fixedRequest = Object.freeze({
        sourceSha256: request.sourceSha256,
        revision: request.revision,
        selectedIds: request.selectedIds === null ? null : Object.freeze([...request.selectedIds]),
      });
      return json(`/api/documents/${encodeURIComponent(documentId)}/comments-to-office`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: COMMENTS_TO_OFFICE_PROFILE,
          sourceSha256: fixedRequest.sourceSha256,
          revision: fixedRequest.revision,
          selectedIds: fixedRequest.selectedIds,
        }),
        signal: options.signal,
      }).then((body) => validateCommentsToOfficeResult(body?.result, {
        documentId,
        sourceSha256: fixedRequest.sourceSha256,
        request: fixedRequest,
      }));
    },
  });
}
