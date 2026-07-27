import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleJpegImageRoute } from '../scripts/host/routes/jpeg-image-routes.mjs';

const requestBody = Object.freeze({ profile: 'local-pdf-jpeg-image-v1', sourceSha256: 'a'.repeat(64), inputId: '123e4567-e89b-12d3-a456-426614174000', inputSha256: 'b'.repeat(64), page: 1, rect: { x: 10, y: 20, width: 100, height: 80 } });

function context({ body = requestBody, ready = true, aborted = false } = {}) {
  const response = new EventEmitter(); const controller = new AbortController(); if (aborted) controller.abort();
  const calls = []; const deleted = [];
  return { request: { method: 'POST' }, response, url: new URL('http://local/api/documents/doc/insert-jpeg'), documentId: 'doc', operation: 'insert-jpeg', processing: { signal: controller.signal }, store: { deleteArtifact: async (id) => deleted.push(id) }, jpegImageReady: ready, jpegImage: ready ? { insert: async (...args) => { calls.push(args); return { kind: 'pdf-jpeg-image', artifact: { id: 'artifact' } }; } } : null, bodyLimit: 2048, exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)), method: (value, expected) => assert.equal(value.method, expected), readJson: async () => body, json: (_response, status, value) => { response.status = status; response.value = value; }, calls, deleted };
}

test('JPEG image route forwards opaque input binding and revokes on disconnect', async () => {
  const value = context(); assert.equal(await handleJpegImageRoute(value), true); assert.equal(value.response.status, 201); assert.deepEqual(value.calls[0][1], requestBody);
  const cancelled = context({ aborted: true }); assert.equal(await handleJpegImageRoute(cancelled), true); assert.deepEqual(cancelled.deleted, ['artifact']);
});

test('JPEG image route rejects unavailable service and extra body keys', async () => {
  await assert.rejects(handleJpegImageRoute(context({ ready: false })), { code: 'PDF_JPEG_IMAGE_UNAVAILABLE' });
  await assert.rejects(handleJpegImageRoute(context({ body: { ...requestBody, jpegBytes: 'not accepted' } })), { code: 'INVALID_PDF_JPEG_IMAGE_OPTIONS' });
});
