import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handlePdfkitProtection } from '../scripts/host/routes/pdfkit-route-handlers.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const sourceSha256 = 'a'.repeat(64);

function fixture({ disconnectDuringProtection = false } = {}) {
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
  const deleted = [];
  const writes = [];
  const context = {
    request: {}, response, url: new URL(`http://local/documents/${documentId}/pdfkit-protection`), documentId,
    processing: { signal: new AbortController().signal },
    store: { async deleteArtifact(id) { deleted.push(id); } },
    pdfkitProtection: { async protect() {
      if (disconnectDuringProtection) { response.destroyed = true; response.emit('close'); }
      return { artifact: { id: artifactId } };
    } },
    protectionBodyLimit: 4096,
    method() {},
    async readJson() { return { profile: 'macos-pdfkit-aes128-v1', sourceSha256, protection: { permissionsProfile: 'deny-all', ownerPassword: 'Owner-Pass-123', userPassword: 'User-Pass-4567' } }; },
    json(_response, status, body) { writes.push({ status, body }); },
  };
  return { context, response, deleted, writes };
}

test('password protection revokes a promoted artifact when the client disconnects before delivery', async () => {
  const value = fixture({ disconnectDuringProtection: true });
  await handlePdfkitProtection(value.context);
  assert.deepEqual(value.deleted, [artifactId]);
  assert.deepEqual(value.writes, []);
});

test('password protection retains delivered artifacts but revokes an undelivered response close', async () => {
  const delivered = fixture();
  await handlePdfkitProtection(delivered.context);
  assert.equal(delivered.writes[0].status, 201);
  delivered.response.emit('finish');
  delivered.response.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered.deleted, []);

  const lost = fixture();
  await handlePdfkitProtection(lost.context);
  lost.response.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lost.deleted, [artifactId]);
});
