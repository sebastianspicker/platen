import assert from 'node:assert/strict'; import { EventEmitter } from 'node:events'; import test from 'node:test'; import { handlePageLabelsRoute } from '../scripts/host/routes/page-labels-routes.mjs';
const body = { profile: 'local-page-labels-v1', sourceSha256: 'a'.repeat(64), ranges: [{ start: 0, style: 'D', prefix: '§ ', startNumber: 1 }] };
function context({ value = body, ready = true, aborted = false } = {}) {
  const response = new EventEmitter(); const controller = new AbortController();
  if (aborted) controller.abort(); const deleted = []; const calls = [];
  return {
    request: { method: 'POST' }, response,
    url: new URL('http://local/api/documents/doc/page-labels'),
    documentId: 'doc', operation: 'page-labels',
    processing: { signal: controller.signal },
    store: { deleteArtifact: async (id) => deleted.push(id) },
    pageLabelsReady: ready,
    pageLabels: ready ? {
      create: async (...args) => {
        calls.push(args); return { artifact: { id: 'artifact' }, labels: ['§ 1'] };
      },
    } : null,
    bodyLimit: 8192,
    exactJsonObject: (candidate, keys) => Boolean(candidate)
      && typeof candidate === 'object' && !Array.isArray(candidate)
      && Object.keys(candidate).length === keys.length
      && Object.keys(candidate).every((key) => keys.includes(key)),
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => value,
    json: (_response, status, result) => { response.status = status; response.value = result; },
    deleted, calls,
  };
}
test('page-label route forwards canonical ranges and revokes on disconnect', async () => { const value = context(); assert.equal(await handlePageLabelsRoute(value), true); assert.equal(value.response.status, 201); assert.deepEqual(value.calls[0][1], body); const cancelled = context({ aborted: true }); assert.equal(await handlePageLabelsRoute(cancelled), true); assert.deepEqual(cancelled.deleted, ['artifact']); });
test('page-label route rejects unavailable and null-prefix requests', async () => { await assert.rejects(handlePageLabelsRoute(context({ ready: false })), { code: 'PDF_PAGE_LABELS_UNAVAILABLE' }); await assert.rejects(handlePageLabelsRoute(context({ value: { ...body, ranges: [{ ...body.ranges[0], prefix: null }] } })), { code: 'INVALID_PDF_PAGE_LABELS_OPTIONS' }); });
