import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createAppHandler } from '../scripts/host/router.mjs';
import { promotePdfAttachmentRemovalArtifact } from '../scripts/host/pdf-attachment-removal-artifact.mjs';
import { inventory } from '../scripts/host/pdf-attachment-removal-validation.mjs';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import { handleAttachmentRemovalRoute } from '../scripts/host/routes/attachment-removal-routes.mjs';

const sourceSha256 = 'a'.repeat(64);
const body = Object.freeze({
  profile: 'local-document-attachment-removal-v1', sourceSha256,
});

function context(value = body, { aborted = false } = {}) {
  const response = new EventEmitter();
  const calls = []; const deleted = [];
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    request: { method: 'POST' }, response,
    url: new URL('http://local.test/api/documents/id/attachment-removal'),
    documentId: 'id', operation: 'attachment-removal',
    processing: { signal: controller.signal },
    store: { deleteArtifact: async (id) => { deleted.push(id); } },
    attachmentRemoval: {
      remove: async (...args) => {
        calls.push(args);
        return {
          artifact: { id: 'attachment-removed' },
          kind: 'pdf-document-attachment-removal',
        };
      },
    },
    bodyLimit: 1_024,
    exactJsonObject: (item, keys) => Boolean(item) && typeof item === 'object'
      && !Array.isArray(item) && Object.keys(item).length === keys.length
      && Object.keys(item).every((key) => keys.includes(key)),
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => value,
    json: (_response, status, result) => {
      response.status = status; response.value = result;
    },
    calls, deleted,
  };
}

test('attachment-removal route accepts only the fixed source-bound request', async () => {
  const value = context();
  assert.equal(await handleAttachmentRemovalRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.deepEqual(value.calls[0][1], { profile: body.profile });
  assert.equal(value.calls[0][2].sourceSha256, sourceSha256);
  assert(value.calls[0][2].signal instanceof AbortSignal);
  for (const invalid of [
    { ...body, extra: true },
    { ...body, profile: 'wrong' },
    { ...body, sourceSha256: sourceSha256.toUpperCase() },
  ]) {
    await assert.rejects(
      handleAttachmentRemovalRoute(context(invalid)),
      { code: 'INVALID_ATTACHMENT_REMOVAL_OPTIONS' },
    );
  }
});

test('attachment-removal route revokes a promoted artifact after cancellation', async () => {
  const value = context(undefined, { aborted: true });
  assert.equal(await handleAttachmentRemovalRoute(value), true);
  assert.deepEqual(value.deleted, ['attachment-removed']);
  assert.equal(value.response.status, undefined);
});

test('router revokes an attachment-removal artifact after disconnect', async () => {
  const deleted = [];
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  const handler = createAppHandler({
    staticHandler() {},
    store: { deleteArtifact: async (id) => { deleted.push(id); } },
    service: {}, workspaceState: {},
    attachmentRemoval: { async remove() {
      response.destroyed = true;
      response.emit('close');
      return {
        artifact: { id: 'router-attachment-removal' },
        kind: 'pdf-document-attachment-removal',
      };
    } },
    token: 'token', host: '127.0.0.1', port: 4173,
  });
  const request = Readable.from([JSON.stringify(body)]);
  Object.assign(request, {
    method: 'POST', url: '/api/documents/id/attachment-removal',
    headers: {
      host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json', 'x-platen-token': 'token',
    },
  });
  await handler(request, response);
  assert.deepEqual(deleted, ['router-attachment-removal']);
});

test('attachment-removal artifact retains only attachment digests and size', async () => {
  let options;
  const removal = {
    profile: body.profile,
    nameSha256: 'b'.repeat(64), contentSha256: 'c'.repeat(64), contentBytes: 42,
  };
  const result = await promotePdfAttachmentRemovalArtifact({
    store: { promotePdfArtifact: async (_id, _path, value) => {
      options = value;
      return { id: 'artifact', sha256: 'd'.repeat(64) };
    } },
    documentId: '11111111-1111-4111-8111-111111111111',
    source: {
      sha256: sourceSha256, displayName: 'source.pdf',
    },
    outputPath: '/private/output.pdf', outputDigest: 'd'.repeat(64),
    pageCount: 1, removal, signal: new AbortController().signal,
  });
  assert.deepEqual(result.removal, removal);
  assert.deepEqual({ ...options.operation.parameters }, removal);
  assert.equal(JSON.stringify(result).includes('private attachment'), false);
});

test('bootstrap exposes attachment-removal readiness', async () => {
  const response = {};
  await handleBootstrapRoute({
    pathname: '/api/bootstrap', request: { method: 'GET' }, response,
    service: { availability: async () => [] }, attachmentRemoval: {},
    token: 'token', method: () => {}, requireLocalFetchMetadata: () => {},
    json: (_response, _status, value) => { response.value = value; },
    sanitizedEngineAvailability: (value) => value,
  });
  assert.equal(response.value.host.attachmentRemovalReady, true);
});

test('attachment-removal inventory rejects malformed or truncated Poppler output', () => {
  assert.deepEqual(inventory('0 embedded files\n'), []);
  assert.deepEqual(inventory('1 embedded files\n1: note.txt\n'), [
    { number: 1, name: 'note.txt' },
  ]);
  for (const output of [
    '', '1 embedded files\n', '0 embedded files\njunk\n',
    '1 embedded files\n2: note.txt\n', '1 embedded files\n1: note.txt\nextra\n',
    '1 embedded files\n1: bad\u0000name\n',
  ]) {
    assert.throws(
      () => inventory(output),
      { code: 'PDF_ATTACHMENT_REMOVAL_POPPLER_OUTPUT_INVALID' },
    );
  }
});
