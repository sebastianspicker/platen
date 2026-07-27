import assert from 'node:assert/strict'; import test from 'node:test'; import { LocalHostClient } from '../src/core/local-host-client.js';
const token = 'a'.repeat(64); const id = '123e4567-e89b-12d3-a456-426614174000';
test('local host client posts exact page-label profile and ranges', async () => {
  const calls = []; const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: { kind: 'pdf-page-labels' } }), { status: 201 });
  } }); await client.bootstrap();
  const request = {
    profile: 'local-page-labels-v1', sourceSha256: 'b'.repeat(64),
    ranges: [{ start: 0, style: 'D', prefix: '§ ', startNumber: 1 }],
  };
  assert.deepEqual(await client.createPageLabels(id, request), { kind: 'pdf-page-labels' });
  assert.equal(calls[1].path, `/api/documents/${id}/page-labels`);
  assert.deepEqual(JSON.parse(calls[1].options.body), request);
  assert.throws(() => client.createPageLabels('doc', request), TypeError);
  assert.throws(() => client.createPageLabels(id, {
    ...request, ranges: [{ ...request.ranges[0], prefix: null }],
  }), TypeError);
});
