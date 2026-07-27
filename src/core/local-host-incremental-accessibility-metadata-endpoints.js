import { INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE, validIncrementalAccessibilityMetadata, validateIncrementalAccessibilityMetadataResult } from './pdf-incremental-accessibility-metadata-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;

async function hashRequest(request) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new TypeError('Accessibility metadata validation requires local SHA-256 support.');
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(request)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createIncrementalAccessibilityMetadataEndpoints({ json }) {
  return Object.freeze({
    runIncrementalAccessibilityMetadata(documentId, sourceSha256, metadata, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '') || !validIncrementalAccessibilityMetadata(metadata) || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Incremental accessibility metadata options are invalid.');
      const request = Object.freeze({ language: metadata.language, title: metadata.title });
      return hashRequest(request).then((requestSha256) => json(
        `/api/documents/${encodeURIComponent(documentId)}/incremental-accessibility-metadata`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE,
            sourceSha256,
            metadata: request,
          }),
          signal: options.signal,
        },
      ).then((body) => validateIncrementalAccessibilityMetadataResult(body?.result, {
        documentId, sourceSha256, request, requestSha256,
      })));
    },
  });
}
