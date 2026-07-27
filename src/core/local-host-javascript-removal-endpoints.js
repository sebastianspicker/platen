import {
  PDF_JAVASCRIPT_REMOVAL_PROFILE,
  validatePdfJavaScriptRemovalResult,
} from './pdf-javascript-removal-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;

export function createJavaScriptRemovalEndpoints({ json }) {
  return Object.freeze({
    runJavaScriptRemoval(documentId, sourceSha256, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('PDF JavaScript-removal options are invalid.');
      }
      return json(`/api/documents/${encodeURIComponent(documentId)}/javascript-removal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: PDF_JAVASCRIPT_REMOVAL_PROFILE, sourceSha256 }),
        signal: options.signal,
      }).then((body) => validatePdfJavaScriptRemovalResult(body?.result, {
        documentId, sourceSha256,
      }));
    },
  });
}
