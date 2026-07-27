import {
  INCREMENTAL_PAGE_VECTOR_PROFILE,
  validateIncrementalPageVectorResult,
  validIncrementalPageVectorRequest,
} from './pdf-incremental-page-vector-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;

export function createIncrementalPageVectorEndpoints({ json }) {
  return Object.freeze({
    runIncrementalPageVector(documentId, sourceSha256, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !validIncrementalPageVectorRequest(request) || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Incremental page-vector options are invalid.');
      }
      return json(`/api/documents/${encodeURIComponent(documentId)}/incremental-page-vector`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: INCREMENTAL_PAGE_VECTOR_PROFILE,
          sourceSha256,
          page: request.page,
          rect: request.rect,
        }),
        signal: options.signal,
      }).then((body) => validateIncrementalPageVectorResult(body?.result, {
        documentId, sourceSha256, request,
      }));
    },
  });
}
