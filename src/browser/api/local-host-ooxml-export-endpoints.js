import { exactObject, OPAQUE_ID_PATTERN } from '../../contracts/pdfkit-client-contract-shared.js';
import { OOXML_EXPORT_PROFILE as PROFILE } from '../../contracts/public-wire-identifiers.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const FORMATS = new Set(['word', 'excel', 'powerpoint']);

export function createOoxmlExportEndpoints({ json }) {
  return Object.freeze({
    exportOoxml(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
        || !exactObject(request, ['profile', 'sourceSha256', 'format'])
        || request.profile !== PROFILE || !SHA256.test(request.sourceSha256 ?? '') || !FORMATS.has(request.format)) {
        throw new TypeError('OOXML export options are invalid.');
      }
      return json(`/api/documents/${encodeURIComponent(documentId)}/export-ooxml`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: options.signal,
      }).then((body) => body?.result);
    },
  });
}

export { PROFILE as OOXML_EXPORT_PROFILE };
