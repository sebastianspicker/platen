import {
  INCREMENTAL_BLEED_BOX_PROFILE,
  validIncrementalBleedBoxRequest,
  validateIncrementalBleedBoxResult,
} from './pdf-incremental-bleed-box-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;

export function createIncrementalBleedBoxEndpoints({ json }) {
  return Object.freeze({
    runIncrementalBleedBox(documentId, sourceSha256, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !validIncrementalBleedBoxRequest(request) || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Incremental PDF BleedBox options are invalid.');
      }
      return json(`/api/documents/${encodeURIComponent(documentId)}/incremental-bleed-box`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: INCREMENTAL_BLEED_BOX_PROFILE,
          sourceSha256,
          page: request.page,
          rect: request.rect,
        }),
        signal: options.signal,
      }).then((body) => validateIncrementalBleedBoxResult(body?.result, {
        documentId, sourceSha256, request,
      }));
    },
  });
}
