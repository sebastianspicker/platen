import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
import {
  normalizeProfessionalPrintTransparencyRequest,
  validateProfessionalPrintTransparencyResponse,
} from './professional-print-transparency-contract.js';

function exactOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  let prototype;
  let descriptors;
  let keys;
  try {
    prototype = Object.getPrototypeOf(options);
    descriptors = Object.getOwnPropertyDescriptors(options);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    return false;
  }
  if (prototype !== Object.prototype || keys.some((key) => key !== 'signal')) return false;
  try { structuredClone(options); } catch { return false; }
  if (keys.length === 0) return true;
  const descriptor = descriptors.signal;
  if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
    || !(typeof AbortSignal === 'function' && descriptor.value instanceof AbortSignal)) return false;
  return true;
}

export function createProfessionalPrintTransparencyEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Professional print transparency endpoints require JSON transport.');
  return Object.freeze({
    flattenPrintTransparency(documentId, request, options = {}) {
      if (typeof documentId !== 'string' || !OPAQUE_ID_PATTERN.test(documentId) || !exactOptions(options)) {
        throw new TypeError('Professional print transparency options are invalid.');
      }
      const normalized = normalizeProfessionalPrintTransparencyRequest(request);
      return json(`/api/documents/${encodeURIComponent(documentId)}/professional-print-transparency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalized),
        signal: options.signal,
      }).then((body) => validateProfessionalPrintTransparencyResponse(body, normalized, documentId));
    },
  });
}
