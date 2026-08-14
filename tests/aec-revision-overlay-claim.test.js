import assert from 'node:assert/strict';
import test from 'node:test';

import { DomainFacade } from '../scripts/host/domain-facade.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { fixture, invoke, makeTextPdf } from './support/host-router-fixture.js';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const FROM_DIGEST = 'a'.repeat(64);
const SOURCE_B = 'b'.repeat(64);
const AUTH = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-platen-token': 'test-session-token',
});

function responseBody(response) {
  return JSON.parse(response.body);
}

function responseCode(response) {
  return responseBody(response).error.code;
}

function callDomain(handler, documentId, body) {
  return invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/domain`,
    headers: AUTH,
    body: JSON.stringify(body),
  });
}

async function upload(handler) {
  const response = await invoke(handler, {
    method: 'POST',
    url: '/api/documents',
    headers: { ...AUTH, 'content-type': 'application/pdf' },
    body: makeTextPdf('source-bound revision overlay'),
  });
  assert.equal(response.statusCode, 201);
  return responseBody(response).document;
}

function createOverlay(handler, documentId, sourceSha256, expectedRevision, overrides = {}) {
  return callDomain(handler, documentId, {
    group: 'AEC',
    operation: 'createRevisionOverlay',
    body: {
      input: {
        id: 'overlay-1',
        fromDigest: FROM_DIGEST,
        toDigest: sourceSha256,
        sheetId: 'sheet-1',
        sourceSha256,
        ...overrides,
      },
      options: { expectedRevision },
    },
  });
}

function assertNoArtifactClaims(record) {
  for (const field of ['alignment', 'pixels', 'pdf', 'artifact', 'output']) {
    assert.equal(Object.hasOwn(record, field), false, `unexpected ${field} field`);
  }
}

test('authenticated current-source revision overlay persists a descriptor-only claim', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const basisRevision = workspaceState.snapshot(document.id).revision;

  const response = await createOverlay(handler, document.id, sourceSha256, basisRevision, {
    fromDigest: FROM_DIGEST.toUpperCase(),
  });
  assert.equal(response.statusCode, 200, response.body);
  const record = responseBody(response).result.namespaces.reviewRecords.at(-1);

  assert.deepEqual(Object.keys(record).sort(), [
    'basisRevision',
    'createdAt',
    'fromDigest',
    'id',
    'mode',
    'sheetId',
    'sourceSha256',
    'toDigest',
    'type',
  ]);
  assert.equal(record.type, 'revision-overlay');
  assert.equal(record.fromDigest, FROM_DIGEST);
  assert.equal(record.toDigest, sourceSha256);
  assert.equal(record.sheetId, 'sheet-1');
  assert.equal(record.sourceSha256, sourceSha256);
  assert.equal(record.basisRevision, basisRevision);
  assert.equal(record.mode, 'descriptor-only');
  assertNoArtifactClaims(record);
  assert.equal(store.getDocument(document.id).sha256, sourceSha256);
});

test('source-bound revision overlays reject forged, mismatched, and stale requests without mutation', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const initialRevision = workspaceState.snapshot(document.id).revision;

  const beforeForged = workspaceState.snapshot(document.id);
  const forged = await createOverlay(handler, document.id, SOURCE_B, initialRevision, {
    toDigest: sourceSha256,
  });
  assert.equal(forged.statusCode, 409);
  assert.equal(responseCode(forged), 'SOURCE_VERSION_MISMATCH');
  assert.deepEqual(workspaceState.snapshot(document.id), beforeForged);
  assert.equal(store.getDocument(document.id).sha256, sourceSha256);

  const beforeMismatch = workspaceState.snapshot(document.id);
  const mismatch = await createOverlay(handler, document.id, sourceSha256, initialRevision, {
    toDigest: SOURCE_B,
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(responseCode(mismatch), 'SOURCE_VERSION_MISMATCH');
  assert.deepEqual(workspaceState.snapshot(document.id), beforeMismatch);
  assert.equal(store.getDocument(document.id).sha256, sourceSha256);

  const created = await createOverlay(handler, document.id, sourceSha256, initialRevision);
  assert.equal(created.statusCode, 200, created.body);
  const staleBefore = workspaceState.snapshot(document.id);
  const stale = await createOverlay(handler, document.id, sourceSha256, initialRevision, {
    id: 'overlay-stale',
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(responseCode(stale), 'REVISION_CONFLICT');
  assert.deepEqual(workspaceState.snapshot(document.id), staleBefore);
  assert.equal(store.getDocument(document.id).sha256, sourceSha256);
});

test('source-bound revision overlays reject equal digests, malformed ids, and extra keys without mutation', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const expectedRevision = workspaceState.snapshot(document.id).revision;

  const beforeEqual = workspaceState.snapshot(document.id);
  const equal = await createOverlay(handler, document.id, sourceSha256, expectedRevision, {
    fromDigest: sourceSha256,
  });
  assert.equal(equal.statusCode, 400);
  assert.equal(responseCode(equal), 'INVALID_REVISION_OVERLAY');
  assert.deepEqual(workspaceState.snapshot(document.id), beforeEqual);

  const beforeId = workspaceState.snapshot(document.id);
  const malformedId = await createOverlay(handler, document.id, sourceSha256, expectedRevision, {
    id: 'overlay id',
  });
  assert.equal(malformedId.statusCode, 400);
  assert.equal(responseCode(malformedId), 'INVALID_ID');
  assert.deepEqual(workspaceState.snapshot(document.id), beforeId);

  const beforeExtra = workspaceState.snapshot(document.id);
  const extra = await createOverlay(handler, document.id, sourceSha256, expectedRevision, {
    alignment: [],
  });
  assert.equal(extra.statusCode, 400);
  assert.equal(responseCode(extra), 'INVALID_PARAMETER');
  assert.deepEqual(workspaceState.snapshot(document.id), beforeExtra);
});

test('legacy DomainFacade revision overlays remain source-unbound', () => {
  const store = new WorkspaceStateStore((value) => value === DOCUMENT_ID);
  const facade = new DomainFacade(store);
  const initial = store.snapshot(DOCUMENT_ID);
  const state = facade.execute(DOCUMENT_ID, {
    group: 'AEC',
    operation: 'createRevisionOverlay',
    body: {
      input: {
        id: 'legacy-overlay',
        fromDigest: FROM_DIGEST.toUpperCase(),
        toDigest: SOURCE_B,
        sheetId: 'legacy-sheet',
      },
      options: { expectedRevision: initial.revision },
    },
  });
  const record = state.namespaces.reviewRecords.at(-1);

  assert.equal(record.type, 'revision-overlay');
  assert.equal(record.fromDigest, FROM_DIGEST);
  assert.equal(record.toDigest, SOURCE_B);
  assert.equal(record.sheetId, 'legacy-sheet');
  assert.equal(Object.hasOwn(record, 'sourceSha256'), false);
  assert.equal(Object.hasOwn(record, 'basisRevision'), false);
  assert.equal(Object.hasOwn(record, 'mode'), false);
  assertNoArtifactClaims(record);
});
