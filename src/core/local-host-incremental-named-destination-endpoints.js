import {
  INCREMENTAL_NAMED_DESTINATION_PROFILE,
  validIncrementalNamedDestinationRequest,
  validateIncrementalNamedDestinationResult,
} from './pdf-incremental-named-destination-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;

async function hashName(value) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new TypeError('Named-destination validation requires local SHA-256 support.');
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createIncrementalNamedDestinationEndpoints({ json }) {
  return Object.freeze({
    runIncrementalNamedDestination(documentId, sourceSha256, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !validIncrementalNamedDestinationRequest(request)
        || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Incremental named-destination options are invalid.');
      }
      const fixedRequest = Object.freeze({
        targetPage: request.targetPage,
        name: request.name,
      });
      const signal = options.signal;
      return hashName(fixedRequest.name).then((nameSha256) => json(
        `/api/documents/${encodeURIComponent(documentId)}/incremental-named-destination`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profile: INCREMENTAL_NAMED_DESTINATION_PROFILE,
            sourceSha256,
            targetPage: fixedRequest.targetPage,
            name: fixedRequest.name,
          }),
          signal,
        },
      ).then((body) => validateIncrementalNamedDestinationResult(body?.result, {
        documentId, sourceSha256, request: fixedRequest, nameSha256,
      })));
    },
  });
}
