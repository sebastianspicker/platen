import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';
import {
  normalizeRedactionOverlayLabelRequest,
  validateRedactionOverlayLabelResponse,
} from './pdf-redaction-overlay-label-contract.js';

export function createRedactionOverlayLabelEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Redaction overlay-label endpoints require a JSON transport.');
  return Object.freeze({
    applyRedactionOverlayLabel(documentId, request, options = {}) {
      const keys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, keys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Redaction overlay-label options are invalid.');
      }
      const normalized = normalizeRedactionOverlayLabelRequest(request);
      return postJson(
        json,
        documentEndpointPath(documentId, '/redaction-overlay-label'),
        normalized,
        options.signal,
      ).then((body) => validateRedactionOverlayLabelResponse(body, {
        documentId,
        sourceSha256: normalized.sourceSha256,
        request: normalized,
      }));
    },
  });
}
