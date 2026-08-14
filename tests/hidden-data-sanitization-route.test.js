import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleHiddenDataSanitizationRoute } from '../scripts/host/routes/hidden-data-sanitization-routes.mjs';

const body = { profile: 'local-pdf-hidden-data-sanitizer-v1', sourceSha256: 'a'.repeat(64) };
function context({ aborted = false, service = true } = {}) {
  const response = new EventEmitter(); const controller = new AbortController();
  if (aborted) controller.abort(); const calls = []; const deleted = [];
  return {
    request: { method: 'POST' }, response,
    url: new URL('http://local/api/documents/doc/sanitize-hidden-data'),
    documentId: 'doc', operation: 'sanitize-hidden-data',
    processing: { signal: controller.signal },
    store: { deleteArtifact: async (id) => deleted.push(id) },
    hiddenDataSanitization: service ? {
      sanitize: async (...args) => {
        calls.push(args); return { artifact: { id: 'artifact-1' }, limitations: ['no secure erasure'] };
      },
    } : null,
    bodyLimit: 1024,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object'
      && !Array.isArray(value) && Object.keys(value).length === keys.length
      && Object.keys(value).every((key) => keys.includes(key)),
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => body,
    json: (_r, status, value) => { response.status = status; response.value = value; },
    calls, deleted,
  };
}
test('hidden-data route forwards fixed profile/source and revokes after cancellation', async () => { const value = context(); assert.equal(await handleHiddenDataSanitizationRoute(value), true); assert.equal(value.response.status, 201); assert.equal(value.calls[0][0], 'doc'); assert.deepEqual(value.calls[0][1], { sourceSha256: body.sourceSha256, signal: value.processing.signal }); for (const invalid of [{ ...body, profile: 'other' }, { ...body, sourceSha256: body.sourceSha256.toUpperCase() }, { ...body, extra: true }]) await assert.rejects(handleHiddenDataSanitizationRoute({ ...context(), readJson: async () => invalid }), { code: 'INVALID_HIDDEN_DATA_SANITIZATION_OPTIONS' }); const cancelled = context({ aborted: true }); assert.equal(await handleHiddenDataSanitizationRoute(cancelled), true); assert.deepEqual(cancelled.deleted, ['artifact-1']); });
test('hidden-data route stays unavailable without service', async () => { await assert.rejects(handleHiddenDataSanitizationRoute(context({ service: false })), { code: 'HIDDEN_DATA_SANITIZATION_UNAVAILABLE' }); });
