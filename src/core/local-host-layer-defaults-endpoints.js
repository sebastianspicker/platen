import { PDF_LAYER_DEFAULTS_PROFILE, normalizePdfLayerDefaults } from './pdf-layer-defaults-contract.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[a-f0-9]{64}$/u;

export function createLayerDefaultsEndpoints({ json }) {
  return Object.freeze({
    runLayerDefaults(documentId, sourceSha256, changes, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !SHA256.test(sourceSha256 ?? '')
        || !exactObject(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
        throw new TypeError('Layer-defaults options are invalid.');
      }
      const request = normalizePdfLayerDefaults({ profile: PDF_LAYER_DEFAULTS_PROFILE, sourceSha256, changes });
      return json(`/api/documents/${encodeURIComponent(documentId)}/layer-defaults`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request), signal: options.signal,
      }).then((body) => body?.result);
    },
  });
}
