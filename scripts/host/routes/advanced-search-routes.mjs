import { HostError } from '../host-error.mjs';
import { PDF_ADVANCED_SEARCH_PROFILE, normalizePdfAdvancedSearch } from '../pdf-advanced-search-contract.mjs';

export async function handleAdvancedSearchRoute({ request, response, url, documentId, operation, processing, advancedSearch, advancedSearchReady, bodyLimit, exactJsonObject, method, readJson, json }) {
  if (operation !== 'advanced-search') return false;
  method(request, 'POST'); if ([...url.searchParams].length) throw new HostError('INVALID_PARAMETER', 'Advanced search does not accept query parameters.', 400);
  if (!advancedSearchReady || !advancedSearch) throw new HostError('PDF_ADVANCED_SEARCH_UNAVAILABLE', 'Advanced search is unavailable.', 503);
  const body = await readJson(request, bodyLimit); const keys = ['profile', 'sourceSha256', 'query', 'mode', 'caseSensitive', 'wholeWord', 'context', 'maxResults'];
  if (!exactJsonObject(body, keys) || body.profile !== PDF_ADVANCED_SEARCH_PROFILE || !/^[0-9a-f]{64}$/u.test(body.sourceSha256)) throw new HostError('INVALID_PDF_ADVANCED_SEARCH_OPTIONS', 'Advanced search requires the fixed profile, current source digest, and bounded options.', 400);
  try { normalizePdfAdvancedSearch({ profile: body.profile, sourceSha256: body.sourceSha256, pages: [{ page: 1, text: '' }], query: body.query, mode: body.mode, caseSensitive: body.caseSensitive, wholeWord: body.wholeWord, context: body.context, maxResults: body.maxResults }); } catch (error) { throw new HostError('INVALID_PDF_ADVANCED_SEARCH_OPTIONS', 'Advanced-search options are outside the bounded canonical contract.', 400, { cause: error }); }
  const { profile, sourceSha256, ...options } = body; const result = await advancedSearch.search(documentId, options, { sourceSha256, signal: processing.signal });
  json(response, 200, { result }); return true;
}
