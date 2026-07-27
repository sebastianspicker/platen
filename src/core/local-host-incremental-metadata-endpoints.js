import {
  INCREMENTAL_METADATA_PROFILE,
  validIncrementalMetadata,
  validateIncrementalMetadataResult,
} from './pdf-incremental-metadata-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/;

/** Pure-local append-only PDF metadata endpoint; the facade supplies authenticated transport. */
export function createIncrementalMetadataEndpoints({ json }) {
  return Object.freeze({
    runIncrementalMetadata(documentId, sourceSha256, metadata, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !validIncrementalMetadata(metadata) || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Incremental PDF metadata options are invalid.');
      }
      return json(`/api/documents/${encodeURIComponent(documentId)}/incremental-metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: INCREMENTAL_METADATA_PROFILE,
          sourceSha256,
          metadata,
        }),
        signal: options.signal,
      }).then((body) => validateIncrementalMetadataResult(body?.result, {
        documentId,
        sourceSha256,
      }));
    },
  });
}
