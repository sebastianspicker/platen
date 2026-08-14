import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleCopyPageRoute } from '../scripts/host/routes/copy-page-routes.mjs';

const primaryDocumentId = '11111111-1111-4111-8111-111111111111';
const secondaryDocumentId = '22222222-2222-4222-8222-222222222222';
const body = Object.freeze({
  profile: 'local-copy-one-page-between-documents-v1',
  primarySourceSha256: 'a'.repeat(64),
  secondaryDocumentId,
  secondarySourceSha256: 'b'.repeat(64),
  sourcePage: 3,
  afterPage: 1,
});

function context(value = body, { aborted = false } = {}) {
  const response = new EventEmitter();
  response.destroyed = false;
  const calls = [];
  const deleted = [];
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    request: { method: 'POST' },
    response,
    url: new URL(`http://local.test/api/documents/${primaryDocumentId}/copy-page`),
    documentId: primaryDocumentId,
    operation: 'copy-page',
    processing: { signal: controller.signal },
    service: { async copyPageBetweenDocuments(...args) {
      calls.push(args);
      return { id: 'copied-page' };
    } },
    store: { async deleteArtifact(id) { deleted.push(id); } },
    bodyLimit: 2_048,
    exactJsonObject: (item, keys) => Boolean(item) && typeof item === 'object'
      && !Array.isArray(item) && Object.keys(item).length === keys.length
      && Object.keys(item).every((key) => keys.includes(key)),
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => value,
    json: (_response, status, result) => {
      response.status = status;
      response.value = result;
    },
    calls,
    deleted,
  };
}

test('copy-page route reconstructs only the fixed ordered service request', async () => {
  const value = context();
  assert.equal(await handleCopyPageRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.deepEqual(value.calls[0], [
    primaryDocumentId,
    secondaryDocumentId,
    {
      profile: body.profile,
      primarySourceSha256: body.primarySourceSha256,
      secondarySourceSha256: body.secondarySourceSha256,
      sourcePage: 3,
      afterPage: 1,
    },
    { signal: value.processing.signal },
  ]);
  for (const invalid of [
    { ...body, extra: true },
    { ...body, profile: 'custom' },
    { ...body, secondaryDocumentId: 'unsafe' },
    { ...body, primarySourceSha256: body.primarySourceSha256.toUpperCase() },
    { ...body, sourcePage: 1.5 },
  ]) {
    await assert.rejects(
      handleCopyPageRoute(context(invalid)),
      { code: 'INVALID_COPY_PAGE_REQUEST' },
    );
  }
});

test('copy-page route revokes a promoted artifact after cancellation', async () => {
  const value = context(undefined, { aborted: true });
  assert.equal(await handleCopyPageRoute(value), true);
  assert.deepEqual(value.deleted, ['copied-page']);
  assert.equal(value.response.status, undefined);
});

test('copy-page route revokes a promoted artifact after response disconnect', async () => {
  const value = context();
  value.service.copyPageBetweenDocuments = async (...args) => {
    value.calls.push(args);
    value.response.destroyed = true;
    value.response.emit('close');
    return { id: 'copied-page' };
  };
  assert.equal(await handleCopyPageRoute(value), true);
  assert.deepEqual(value.deleted, ['copied-page']);
  assert.equal(value.response.status, undefined);
});
