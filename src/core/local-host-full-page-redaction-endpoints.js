import {
  FULL_PAGE_REDACTION_BATCH_PROFILE, FULL_PAGE_REDACTION_PROFILE,
  validateFullPageRedactionBatchResult, validateFullPageRedactionResult,
  validFullPageRedactionBatchRequest, validFullPageRedactionRequest,
} from './pdf-full-page-redaction-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;

export function createFullPageRedactionEndpoints({ json }) {
  return Object.freeze({
    runFullPageRedaction(documentId, sourceSha256, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '') || !validFullPageRedactionRequest(request)
        || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Full-page redaction options are invalid.');
      }
      const fixedRequest = Object.freeze({ page: request.page });
      return json(`/api/documents/${encodeURIComponent(documentId)}/full-page-redaction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: FULL_PAGE_REDACTION_PROFILE, sourceSha256, page: fixedRequest.page }), signal: options.signal,
      }).then((body) => validateFullPageRedactionResult(body?.result, { documentId, sourceSha256, request: fixedRequest }));
    },
    runFullPageRedactionBatch(documentId, sourceSha256, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '') || !validFullPageRedactionBatchRequest(request)
        || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Full-page redaction batch options are invalid.');
      }
      const fixedRequest = Object.freeze({ pages: Object.freeze([...request.pages]) });
      return json(`/api/documents/${encodeURIComponent(documentId)}/full-page-redaction-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256, pages: fixedRequest.pages }), signal: options.signal,
      }).then((body) => validateFullPageRedactionBatchResult(body?.result, { documentId, sourceSha256, request: fixedRequest }));
    },
  });
}
