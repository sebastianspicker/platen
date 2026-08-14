import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleDocumentRoutes } from '../scripts/host/router-document-dispatch.mjs';
import { handleOcrEditableRoute } from '../scripts/host/routes/ocr-editable-routes.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const sourceSha256 = 'a'.repeat(64);

function routeFixture({ disconnected = false, forged = false } = {}) {
  const response = Object.assign(new EventEmitter(), { destroyed: disconnected, writableEnded: false });
  const deleted = []; const writes = [];
  const result = { sourceDigest: forged ? 'b'.repeat(64) : sourceSha256, artifact: { id: artifactId, documentId: forged ? 'other' : documentId } };
  return {
    deleted, writes, response,
    context: {
      request: {}, response, url: new URL(`http://local/api/documents/${documentId}/ocr-editable`), documentId, operation: 'ocr-editable',
      processing: { signal: new AbortController().signal },
      store: { async deleteArtifact(id) { deleted.push(id); } },
      ocrEditableOutput: { async export(id, options) { assert.equal(id, documentId); assert.equal(options.sourceSha256, sourceSha256); return result; } },
      method() {}, async readJson() { return { sourceSha256, language: 'eng' }; },
      json(_response, status, body) { writes.push({ status, body }); },
    },
  };
}

test('editable OCR route publishes only the exact source-bound result and revokes failed delivery', async () => {
  const delivered = routeFixture();
  assert.equal(await handleOcrEditableRoute(delivered.context), true);
  assert.equal(delivered.writes[0].status, 201);
  delivered.response.emit('finish'); delivered.response.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered.deleted, []);

  const disconnected = routeFixture({ disconnected: true });
  assert.equal(await handleOcrEditableRoute(disconnected.context), true);
  assert.deepEqual(disconnected.deleted, [artifactId]);
  assert.deepEqual(disconnected.writes, []);

  const forged = routeFixture({ forged: true });
  await assert.rejects(handleOcrEditableRoute(forged.context), { code: 'OCR_EDITABLE_RESULT_INVALID', status: 502 });
  assert.deepEqual(forged.deleted, [artifactId]);
});

test('document dispatcher admits the authenticated editable OCR operation', async () => {
  let called = false;
  const routes = new Proxy({}, { get(_target, key) {
    if (key === 'ocrEditable') return async ({ operation, ocrEditableOutput }) => { called = true; assert.equal(operation, 'ocr-editable'); assert.equal(ocrEditableOutput, 'service'); return true; };
    return async () => false;
  } });
  const handled = await handleDocumentRoutes({
    pathname: `/api/documents/${documentId}/ocr-editable`, request: {}, response: {}, url: new URL(`http://local/api/documents/${documentId}/ocr-editable`),
    processing: { signal: new AbortController().signal }, store: {}, workspaceState: {}, routes, limits: {}, ocrEditableOutput: 'service',
  });
  assert.equal(handled, true); assert.equal(called, true);
});
