import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handlePdfkitMutation } from '../scripts/host/routes/pdfkit-route-handlers.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const sourceSha256 = 'a'.repeat(64);

function fixture({ closeBeforeFinish = false } = {}) {
  const response = Object.assign(new EventEmitter(), { destroyed: false });
  const deleted = [];
  const writes = [];
  const context = {
    request: {}, response, url: new URL(`http://local/documents/${documentId}/pdfkit-mutation`),
    documentId, processing: { signal: new AbortController().signal },
    store: { async deleteArtifact(id) { deleted.push(id); } },
    pdfkitMutations: { async mutate() {
      if (closeBeforeFinish) { response.destroyed = true; response.emit('close'); }
      return { artifact: { id: artifactId } };
    } },
    mutationBodyLimit: 4_096,
    method() {},
    async readJson() {
      return {
        profile: 'macos-pdfkit-targeted-v1', sourceSha256,
        mutation: { formFill: null, annotationUpdate: null, annotationProperties: null, annotationRemove: {} },
      };
    },
    json(_response, status, body) { writes.push({ status, body }); },
  };
  return { context, response, deleted, writes };
}

test('PDFKit mutation route revokes a retained artifact when the client closes before delivery', async () => {
  const value = fixture({ closeBeforeFinish: true });
  await handlePdfkitMutation(value.context);
  assert.deepEqual(value.deleted, [artifactId]);
  assert.deepEqual(value.writes, []);
});

test('PDFKit mutation route retains delivery but cleans a later undelivered response close', async () => {
  const delivered = fixture();
  await handlePdfkitMutation(delivered.context);
  assert.equal(delivered.writes[0].status, 201);
  delivered.response.emit('finish');
  delivered.response.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered.deleted, []);

  const lost = fixture();
  await handlePdfkitMutation(lost.context);
  lost.response.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lost.deleted, [artifactId]);
});
