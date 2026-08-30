import {
  COMMENTS_TO_OFFICE_PROFILE,
  validateCommentsToOfficeResult,
} from '../../contracts/local-host-comments-to-office-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from '../../contracts/pdfkit-client-contract-shared.js';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_RECORDS = 500;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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
      return postJson(json, documentEndpointPath(documentId, '/comments-to-office'), {
        profile: COMMENTS_TO_OFFICE_PROFILE,
        sourceSha256: fixedRequest.sourceSha256,
        revision: fixedRequest.revision,
        selectedIds: fixedRequest.selectedIds,
      }, options.signal).then((body) => validateCommentsToOfficeResult(body?.result, {
        documentId,
        sourceSha256: fixedRequest.sourceSha256,
        request: fixedRequest,
      }));
    },
  });
}
