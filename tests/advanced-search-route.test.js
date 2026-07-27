import assert from 'node:assert/strict'; import { EventEmitter } from 'node:events'; import test from 'node:test'; import { handleAdvancedSearchRoute } from '../scripts/host/routes/advanced-search-routes.mjs';
const body = { profile: 'local-pdf-advanced-search-v1', sourceSha256: 'a'.repeat(64), query: 'café *', mode: 'wildcard', caseSensitive: false, wholeWord: false, context: 8, maxResults: 20 };
function context({ value = body, ready = true } = {}) {
  const response = new EventEmitter(); const calls = [];
  return {
    request: { method: 'POST' }, response,
    url: new URL('http://local/api/documents/doc/advanced-search'), documentId: 'doc', operation: 'advanced-search',
    processing: { signal: new AbortController().signal }, advancedSearchReady: ready,
    advancedSearch: ready ? { search: async (...args) => { calls.push(args); return { profile: body.profile, sourceSha256: body.sourceSha256, matches: [], totalMatches: 0, truncated: false }; } } : null,
    bodyLimit: 4096,
    exactJsonObject: (candidate, keys) => Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate) && Object.keys(candidate).length === keys.length && Object.keys(candidate).every((key) => keys.includes(key)),
    method: (request, expected) => assert.equal(request.method, expected), readJson: async () => value,
    json: (_response, status, result) => { response.status = status; response.value = result; }, calls,
  };
}
test('advanced-search route forwards exact options and rejects all-wildcard queries', async () => { const value = context(); assert.equal(await handleAdvancedSearchRoute(value), true); assert.equal(value.response.status, 200); assert.deepEqual(value.calls[0][1], { query: body.query, mode: body.mode, caseSensitive: false, wholeWord: false, context: 8, maxResults: 20 }); await assert.rejects(handleAdvancedSearchRoute(context({ value: { ...body, query: '***' } })), { code: 'INVALID_PDF_ADVANCED_SEARCH_OPTIONS' }); });
