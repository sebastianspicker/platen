import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture, invoke, makeTextPdf } from './support/host-router-fixture.js';

const SOURCE_B = 'b'.repeat(64);
const AUTH = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-platen-token': 'test-session-token',
});

async function upload(handler) {
  const response = await invoke(handler, {
    method: 'POST',
    url: '/api/documents',
    headers: { ...AUTH, 'content-type': 'application/pdf' },
    body: makeTextPdf('source-bound sheet metadata'),
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body).document;
}

function callDomain(handler, documentId, body) {
  return invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/domain`,
    headers: AUTH,
    body: JSON.stringify(body),
  });
}

function createSheet(handler, documentId, sourceSha256, revision, overrides = {}) {
  return callDomain(handler, documentId, {
    group: 'AEC',
    operation: 'createSheet',
    body: {
      input: {
        number: 'A100',
        title: 'Plan',
        page: 1,
        tags: ['permit', 'source-bound'],
        sourceSha256,
        ...overrides,
      },
      options: { expectedRevision: revision },
    },
  });
}

function responseCode(response) {
  return JSON.parse(response.body).error.code;
}

test('authenticated source-bound sheet metadata claim stores source-bound records and enforces page/tag bounds', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const documentDigest = store.getDocument(document.id).sha256;

  let revision = workspaceState.snapshot(document.id).revision;
  const tags = Array.from({ length: 50 }, (_value, index) => `tag-${index}`);
  const valid = await createSheet(handler, document.id, documentDigest, revision, { tags });
  assert.equal(valid.statusCode, 200);
  const record = JSON.parse(valid.body).result.namespaces.reviewRecords.at(-1);
  assert.equal(record.page, 1);
  assert.equal(record.sourceSha256, documentDigest);
  assert.equal(record.basisRevision, revision);
  assert.equal(record.tags.length, 50);
  assert.equal(Object.hasOwn(record, 'pdf'), false);

  revision = workspaceState.snapshot(document.id).revision;
  const forged = await createSheet(handler, document.id, SOURCE_B, revision);
  assert.equal(forged.statusCode, 409);
  assert.equal(responseCode(forged), 'SOURCE_VERSION_MISMATCH');

  const stale = await createSheet(handler, document.id, documentDigest, 0);
  assert.equal(stale.statusCode, 409);
  assert.equal(responseCode(stale), 'REVISION_CONFLICT');

  const hugePage = await createSheet(handler, document.id, documentDigest, revision, { page: 100_001 });
  assert.equal(hugePage.statusCode, 400);
  assert.equal(responseCode(hugePage), 'INVALID_PARAMETER');

  const fractionalPage = await createSheet(handler, document.id, documentDigest, revision, { page: 1.5 });
  assert.equal(fractionalPage.statusCode, 400);
  assert.equal(responseCode(fractionalPage), 'INVALID_PARAMETER');

  const tooManyTags = await createSheet(handler, document.id, documentDigest, revision, {
    tags: Array.from({ length: 51 }, (_value, index) => `tag-${index}`),
  });
  assert.equal(tooManyTags.statusCode, 400);
  assert.equal(responseCode(tooManyTags), 'INVALID_LIST');

  const longTag = await createSheet(handler, document.id, documentDigest, revision, {
    tags: ['x'.repeat(81)],
  });
  assert.equal(longTag.statusCode, 400);
  assert.equal(responseCode(longTag), 'INVALID_INPUT');
});
