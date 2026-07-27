import {
  PDF_PAGE_TEXT_PROFILE, validatePageTextResult, validPageTextRequest,
} from './pdf-page-text-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;

async function hashText(value) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new TypeError('Page-text validation requires local SHA-256 support.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createPageTextEndpoints({ json }) {
  return Object.freeze({
    runPageText(documentId, sourceSha256, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !validPageTextRequest(request) || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Page-text options are invalid.');
      }
      const fixedRequest = Object.freeze({
        page: request.page, x: request.x, y: request.y, size: request.size, text: request.text,
      });
      return hashText(fixedRequest.text).then((textSha256) => json(
        `/api/documents/${encodeURIComponent(documentId)}/page-text`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: PDF_PAGE_TEXT_PROFILE, sourceSha256, ...fixedRequest }),
          signal: options.signal,
        },
      ).then((body) => validatePageTextResult(body?.result, {
        documentId, sourceSha256, request: fixedRequest, textSha256,
      })));
    },
  });
}
