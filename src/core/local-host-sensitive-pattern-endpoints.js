import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';
import {
  normalizePdfSensitivePatternRequest,
  validatePdfSensitivePatternResponse,
} from './pdf-sensitive-pattern-contract.js';

export function createSensitivePatternEndpoints({ json }) {
  return Object.freeze({
    findSensitivePatterns(documentId, request, options = {}) {
      const keys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, keys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Sensitive-pattern options are invalid.');
      }
      const normalized = normalizePdfSensitivePatternRequest(request);
      return postJson(
        json,
        documentEndpointPath(documentId, '/sensitive-patterns'),
        normalized,
        options.signal,
      ).then((body) => validatePdfSensitivePatternResponse(body, {
        documentId, sourceSha256: normalized.sourceSha256, request: normalized,
      }));
    },
  });
}
