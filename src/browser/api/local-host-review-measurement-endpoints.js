import { validateReviewMeasurementResult } from '../../contracts/local-host-review-measurement-contract.js';
import { normalizePdfReviewMeasurement } from '../../contracts/pdf-review-measurement-contract.mjs';
import { OPAQUE_ID_PATTERN } from '../../contracts/pdfkit-client-contract-shared.js';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}

export function createReviewMeasurementEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Review-measurement endpoints require a JSON transport.');
  return Object.freeze({
    createReviewMeasurement(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exact(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Review-measurement options are invalid.');
      let normalized;
      try { normalized = normalizePdfReviewMeasurement(request); } catch { throw new TypeError('Review-measurement options are invalid.'); }
      return postJson(json, documentEndpointPath(documentId, '/review-measurement'), normalized, options.signal)
        .then((body) => validateReviewMeasurementResult(body?.result, { documentId, request: normalized }));
    },
  });
}
