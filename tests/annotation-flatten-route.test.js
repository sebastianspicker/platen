import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleAnnotationFlattenRoute } from '../scripts/host/routes/annotation-flatten-routes.mjs';

const documentId = '11111111-1111-4111-8111-111111111111'; const sourceSha256 = 'a'.repeat(64);
const body = { profile: 'local-square-annotation-flatten-v1', sourceSha256, target: { page: 1, annotationIndex: 0, fingerprint: 'b'.repeat(64), subtype: 'square' } };
function context(changes = {}) {
  const calls = []; const response = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
  return { calls, response, value: {
    request: {}, response, url: new URL(`http://local.test/api/documents/${documentId}/annotation-flatten`), documentId, operation: 'annotation-flatten', processing: { signal: new AbortController().signal }, store: { deleteArtifact: async (id) => calls.push(['delete', id]) },
    annotationFlatten: { flatten: async (...args) => { calls.push(['flatten', ...args]); return { artifact: { id: '22222222-2222-4222-8222-222222222222' }, kind: 'pdf-square-annotation-flatten' }; } }, bodyLimit: 2048,
    exactJsonObject: (value, keys) => value && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)), method: () => {}, readJson: async () => body, json: (_response, status, payload) => calls.push(['json', status, payload]), ...changes,
  } };
}

test('annotation-flatten route reconstructs the exact ordered service request', async () => {
  const setup = context(); assert.equal(await handleAnnotationFlattenRoute(setup.value), true);
  const call = setup.calls.find(([name]) => name === 'flatten');
  assert.equal(call[1], documentId);
  assert.deepEqual(call[2], body);
  assert.equal(call[3].sourceSha256, sourceSha256);
  assert.equal(call[3].signal, setup.value.processing.signal);
  assert.equal(setup.calls.at(-1)[1], 201);
});

test('annotation-flatten route rejects query parameters and revokes on disconnect', async () => {
  const query = context(); query.value.url.searchParams.set('debug', '1');
  await assert.rejects(handleAnnotationFlattenRoute(query.value), { code: 'INVALID_PARAMETER' });
  const disconnected = context({ annotationFlatten: { flatten: async () => { disconnected.response.destroyed = true; disconnected.response.emit('close'); return { artifact: { id: '22222222-2222-4222-8222-222222222222' } }; } } });
  assert.equal(await handleAnnotationFlattenRoute(disconnected.value), true);
  assert.deepEqual(disconnected.calls, [['delete', '22222222-2222-4222-8222-222222222222']]);
});
