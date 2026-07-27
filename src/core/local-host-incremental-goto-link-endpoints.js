import {
  INCREMENTAL_GOTO_LINK_PROFILE,
  validIncrementalGoToLinkRequest,
  validateIncrementalGoToLinkResult,
} from './pdf-incremental-goto-link-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;

export function createIncrementalGoToLinkEndpoints({ json }) {
  return Object.freeze({
    runIncrementalGoToLink(documentId, sourceSha256, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !validIncrementalGoToLinkRequest(request) || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Incremental PDF GoTo-link options are invalid.');
      }
      return json(`/api/documents/${encodeURIComponent(documentId)}/incremental-goto-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: INCREMENTAL_GOTO_LINK_PROFILE,
          sourceSha256,
          sourcePage: request.sourcePage,
          targetPage: request.targetPage,
          rect: request.rect,
        }),
        signal: options.signal,
      }).then((body) => validateIncrementalGoToLinkResult(body?.result, {
        documentId, sourceSha256, request,
      }));
    },
  });
}
