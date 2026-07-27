import {
  INCREMENTAL_PAGE_TRANSITION_PROFILE,
  validateIncrementalPageTransitionResult,
  validIncrementalPageTransitionRequest,
} from './pdf-incremental-page-transition-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/u;

export function createIncrementalPageTransitionEndpoints({ json }) {
  return Object.freeze({
    runIncrementalPageTransition(documentId, sourceSha256, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !validIncrementalPageTransitionRequest(request) || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Incremental page-transition options are invalid.');
      }
      return json(`/api/documents/${encodeURIComponent(documentId)}/incremental-page-transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: INCREMENTAL_PAGE_TRANSITION_PROFILE,
          sourceSha256,
          pages: request.pages,
          transition: request.transition,
          duration: request.duration,
        }),
        signal: options.signal,
      }).then((body) => validateIncrementalPageTransitionResult(body?.result, {
        documentId, sourceSha256, request,
      }));
    },
  });
}
