import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
const SHA256 = /^[0-9a-f]{64}$/u;
export function createHiddenDataSanitizationEndpoints({ json }) {
  return Object.freeze({
    sanitizeHiddenData(documentId, sourceSha256, options = {}) {
      const keys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '') || !exactObject(options, keys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Hidden-data sanitization options are invalid.');
      return json(`/api/documents/${encodeURIComponent(documentId)}/sanitize-hidden-data`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: 'local-pdf-hidden-data-sanitizer-v1', sourceSha256 }), signal: options.signal }).then((body) => body?.result);
    },
  });
}
