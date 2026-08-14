import {
  PDF_FAST_WEB_VIEW_PROFILE,
  validatePdfFastWebViewResult,
} from './pdf-fast-web-view-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/u;

export function createFastWebViewEndpoints({ json }) {
  return Object.freeze({
    runFastWebView(documentId, sourceSha256, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('PDF fast-web-view options are invalid.');
      }
      return json(`/api/documents/${encodeURIComponent(documentId)}/fast-web-view`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: PDF_FAST_WEB_VIEW_PROFILE, sourceSha256 }),
        signal: options.signal,
      }).then((body) => validatePdfFastWebViewResult(body?.result, { documentId, sourceSha256 }));
    },
  });
}
