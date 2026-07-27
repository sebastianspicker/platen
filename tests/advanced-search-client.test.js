import assert from 'node:assert/strict'; import test from 'node:test'; import { LocalHostClient } from '../src/core/local-host-client.js';
const token = 'a'.repeat(64); const id = '123e4567-e89b-12d3-a456-426614174000';
test('local host client validates and posts advanced-search options', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: { totalMatches: 1, matches: [{ page: 1, start: 0, end: 5, text: 'café', snippet: { text: 'café', start: 0, end: 5 } }] } }), { status: 200 });
  } });
  await client.bootstrap();
  const request = { profile: 'local-pdf-advanced-search-v1', sourceSha256: 'b'.repeat(64), query: 'café', mode: 'literal', caseSensitive: false, wholeWord: false, context: 8, maxResults: 20 };
  assert.equal((await client.searchAdvancedText(id, request)).totalMatches, 1);
  assert.equal(calls[1].path, `/api/documents/${id}/advanced-search`);
  assert.deepEqual(JSON.parse(calls[1].options.body), request);
  assert.throws(() => client.searchAdvancedText(id, { ...request, query: '***', mode: 'wildcard' }), TypeError);
  assert.throws(() => client.searchAdvancedText(id, { ...request, query: 'x\u0000' }), TypeError);
});
