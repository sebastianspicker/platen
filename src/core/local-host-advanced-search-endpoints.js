import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';
const SHA256 = /^[a-f0-9]{64}$/u; const PROFILE = 'local-pdf-advanced-search-v1';
function text(value) { return typeof value === 'string' && value === value.normalize('NFC') && [...value].length >= 1 && [...value].length <= 128 && ![...value].some((point) => /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(point)); }
export function createAdvancedSearchEndpoints({ json }) {
  return Object.freeze({
    searchAdvancedText(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      const invalidOptions = !OPAQUE_ID_PATTERN.test(documentId ?? '')
        || !exactObject(options, optionKeys)
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal));
      if (invalidOptions) throw new TypeError('Advanced-search options are invalid.');
      const invalidRequest = !exactObject(request, ['profile', 'sourceSha256', 'query', 'mode', 'caseSensitive', 'wholeWord', 'context', 'maxResults'])
        || request.profile !== PROFILE || !SHA256.test(request.sourceSha256 ?? '')
        || !text(request.query) || !['literal', 'wildcard'].includes(request.mode)
        || (request.mode === 'wildcard' && [...request.query].every((point) => point === '*' || point === '?'))
        || typeof request.caseSensitive !== 'boolean' || typeof request.wholeWord !== 'boolean'
        || !Number.isSafeInteger(request.context) || request.context < 0 || request.context > 200
        || !Number.isSafeInteger(request.maxResults) || request.maxResults < 1 || request.maxResults > 1_000;
      if (invalidRequest) throw new TypeError('Advanced-search request is invalid.');
      return json(`/api/documents/${encodeURIComponent(documentId)}/advanced-search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request), signal: options.signal,
      }).then((body) => body?.result);
    },
  });
}
