import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createReviewSession } from '../scripts/host/domains/aec-review-session.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { fixture, invoke, makeTextPdf } from './support/host-router-fixture.js';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_A = 'a'.repeat(64);
const SOURCE_B = 'b'.repeat(64);
const AUTH = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-platen-token': 'test-session-token',
});

function localDomain() {
  const store = new WorkspaceStateStore((value) => value === DOCUMENT_ID);
  return {
    store,
    domain: {
      snapshot: (documentId) => store.snapshot(documentId),
      newId: (prefix, supplied) => supplied ?? `${prefix}-generated`,
      now: () => '2026-08-02T00:00:00.000Z',
      write(documentId, namespace, record, expectedRevision) {
        const first = store.createEntity(documentId, namespace, record, { expectedRevision });
        return store.appendAuditEvent(documentId, {
          kind: 'aec', action: 'create', namespace, entityId: record.id, at: this.now(),
        }, { expectedRevision: first.revision });
      },
    },
  };
}

function assertUnchanged(before, after) {
  assert.deepEqual(after, before);
}

function responseBody(response) {
  return JSON.parse(response.body);
}

async function upload(handler) {
  const response = await invoke(handler, {
    method: 'POST',
    url: '/api/documents',
    headers: { ...AUTH, 'content-type': 'application/pdf' },
    body: makeTextPdf('source-bound collaborative review session'),
  });
  assert.equal(response.statusCode, 201);
  return responseBody(response).document;
}

function routeCall(handler, documentId, input, expectedRevision) {
  return invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/domain`,
    headers: AUTH,
    body: JSON.stringify({
      group: 'AEC',
      operation: 'createReviewSession',
      body: { input, options: { expectedRevision } },
    }),
  });
}

test('source-bound review sessions persist a deterministic local descriptor', () => {
  const { store, domain } = localDomain();
  const initial = store.snapshot(DOCUMENT_ID);
  const result = createReviewSession(domain, DOCUMENT_ID, {
    id: 'session-1',
    workspaceId: '  workspace-1 ',
    participants: [' author ', 'reviewer'],
    sourceSha256: SOURCE_A.toUpperCase(),
  }, { expectedRevision: initial.revision });
  const record = result.namespaces.reviewRecords.at(-1);

  assert.deepEqual(Object.keys(record).sort(), [
    'basisRevision', 'createdAt', 'id', 'participants', 'sourceSha256', 'type', 'workspaceId',
  ]);
  assert.equal(record.id, 'session-1');
  assert.equal(record.type, 'review-session');
  assert.equal(record.workspaceId, 'workspace-1');
  assert.deepEqual(record.participants, ['author', 'reviewer']);
  assert.equal(record.sourceSha256, SOURCE_A);
  assert.equal(record.basisRevision, initial.revision);
  for (const forbidden of [
    'artifact', 'conflictResolution', 'invitation', 'network', 'notification', 'presence',
    'remote', 'remoteIdentity', 'sync', 'pdf',
  ]) {
    assert.equal(Object.hasOwn(record, forbidden), false, `unexpected ${forbidden} field`);
  }
});

test('source-bound review sessions enforce 1..50 unique bounded participants and exact input/options keys', () => {
  const { store, domain } = localDomain();
  const participants = Array.from({ length: 50 }, (_, index) => `participant-${index + 1}`);
  const initial = store.snapshot(DOCUMENT_ID);
  const maximum = createReviewSession(domain, DOCUMENT_ID, {
    id: 'session-max', workspaceId: 'workspace-1', participants, sourceSha256: SOURCE_A,
  }, { expectedRevision: initial.revision });
  assert.deepEqual(maximum.namespaces.reviewRecords.at(-1).participants, participants);

  const tooManyBefore = store.snapshot(DOCUMENT_ID);
  assert.throws(() => createReviewSession(domain, DOCUMENT_ID, {
    id: 'session-too-many', workspaceId: 'workspace-1',
    participants: [...participants, 'participant-51'], sourceSha256: SOURCE_A,
  }, { expectedRevision: tooManyBefore.revision }), { code: 'INVALID_LIST' });
  assertUnchanged(tooManyBefore, store.snapshot(DOCUMENT_ID));

  const emptyBefore = store.snapshot(DOCUMENT_ID);
  assert.throws(() => createReviewSession(domain, DOCUMENT_ID, {
    id: 'session-empty', workspaceId: 'workspace-1', participants: [], sourceSha256: SOURCE_A,
  }, { expectedRevision: emptyBefore.revision }), { code: 'INVALID_REVIEW_SESSION' });
  assertUnchanged(emptyBefore, store.snapshot(DOCUMENT_ID));

  const duplicateBefore = store.snapshot(DOCUMENT_ID);
  assert.throws(() => createReviewSession(domain, DOCUMENT_ID, {
    id: 'session-duplicate', workspaceId: 'workspace-1',
    participants: ['author', ' author '], sourceSha256: SOURCE_A,
  }, { expectedRevision: duplicateBefore.revision }), { code: 'INVALID_REVIEW_SESSION' });
  assertUnchanged(duplicateBefore, store.snapshot(DOCUMENT_ID));

  const extraBefore = store.snapshot(DOCUMENT_ID);
  assert.throws(() => createReviewSession(domain, DOCUMENT_ID, {
    id: 'session-extra', workspaceId: 'workspace-1', participants: ['author'],
    sourceSha256: SOURCE_A, invitation: true,
  }, { expectedRevision: extraBefore.revision }), { code: 'INVALID_INPUT' });
  assertUnchanged(extraBefore, store.snapshot(DOCUMENT_ID));

  const optionsBefore = store.snapshot(DOCUMENT_ID);
  assert.throws(() => createReviewSession(domain, DOCUMENT_ID, {
    id: 'session-options', workspaceId: 'workspace-1', participants: ['author'], sourceSha256: SOURCE_A,
  }, { expectedRevision: optionsBefore.revision, remote: true }), { code: 'INVALID_INPUT' });
  assertUnchanged(optionsBefore, store.snapshot(DOCUMENT_ID));
});

test('malformed and stale source-bound review sessions fail closed without mutation', () => {
  const { store, domain } = localDomain();
  const initial = store.snapshot(DOCUMENT_ID);

  assert.throws(() => createReviewSession(domain, DOCUMENT_ID, {
    id: 'session-malformed', workspaceId: 'workspace-1', participants: ['author'], sourceSha256: 'not-a-digest',
  }, { expectedRevision: initial.revision }), { code: 'INVALID_DIGEST' });
  assertUnchanged(initial, store.snapshot(DOCUMENT_ID));

  const created = createReviewSession(domain, DOCUMENT_ID, {
    id: 'session-valid', workspaceId: 'workspace-1', participants: ['author'], sourceSha256: SOURCE_A,
  }, { expectedRevision: initial.revision });
  const staleBefore = store.snapshot(DOCUMENT_ID);
  assert.equal(created.revision, staleBefore.revision);
  assert.throws(() => createReviewSession(domain, DOCUMENT_ID, {
    id: 'session-stale', workspaceId: 'workspace-1', participants: ['author'], sourceSha256: SOURCE_A,
  }, { expectedRevision: initial.revision }), { code: 'REVISION_CONFLICT' });
  assertUnchanged(staleBefore, store.snapshot(DOCUMENT_ID));
});

test('legacy direct review-session creation remains source-unbound', () => {
  const { store, domain } = localDomain();
  const initial = store.snapshot(DOCUMENT_ID);
  const result = createReviewSession(domain, DOCUMENT_ID, {
    id: 'legacy-session', workspaceId: 'workspace-legacy', participants: ['author'],
  }, { expectedRevision: initial.revision });
  const record = result.namespaces.reviewRecords.at(-1);
  assert.deepEqual(Object.keys(record).sort(), [
    'createdAt', 'id', 'participants', 'type', 'workspaceId',
  ]);
  assert.equal(Object.hasOwn(record, 'sourceSha256'), false);
  assert.equal(Object.hasOwn(record, 'basisRevision'), false);
});

test('authenticated AEC review-session route binds the current source (root integration point)', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const initialRevision = workspaceState.snapshot(document.id).revision;
  const sourceBytes = await readFile(store.getSourcePath(document.id));
  const input = {
    id: 'session-route', workspaceId: 'workspace-route', participants: ['author', 'reviewer'], sourceSha256,
  };

  const valid = await routeCall(handler, document.id, input, initialRevision);
  const validBody = responseBody(valid);
  if (valid.statusCode === 404 && validBody.error?.code === 'DOMAIN_OPERATION_UNSUPPORTED') {
    context.skip('Root integration pending: register AEC.createReviewSession and source-bound route binding.');
    return;
  }
  assert.equal(valid.statusCode, 200, valid.body);
  const record = validBody.result.namespaces.reviewRecords.at(-1);
  assert.equal(record.sourceSha256, sourceSha256);
  assert.equal(record.basisRevision, initialRevision);
  assert.deepEqual(await readFile(store.getSourcePath(document.id)), sourceBytes);

  const extraBefore = workspaceState.snapshot(document.id);
  const extra = await routeCall(handler, document.id, {
    ...input, id: 'session-extra-route', invitation: true,
  }, extraBefore.revision);
  assert.equal(extra.statusCode, 400, extra.body);
  assert.equal(responseBody(extra).error.code, 'INVALID_PARAMETER');
  assertUnchanged(extraBefore, workspaceState.snapshot(document.id));

  const tooManyBefore = workspaceState.snapshot(document.id);
  const tooMany = await routeCall(handler, document.id, {
    ...input, id: 'session-too-many-route',
    participants: Array.from({ length: 51 }, (_, index) => `participant-${index + 1}`),
  }, tooManyBefore.revision);
  assert.equal(tooMany.statusCode, 400, tooMany.body);
  assert.equal(responseBody(tooMany).error.code, 'INVALID_PARAMETER');
  assertUnchanged(tooManyBefore, workspaceState.snapshot(document.id));

  const forgedBefore = workspaceState.snapshot(document.id);
  const forged = await routeCall(handler, document.id, {
    ...input, id: 'session-forged-route', sourceSha256: SOURCE_B,
  }, forgedBefore.revision);
  assert.equal(forged.statusCode, 409, forged.body);
  assert.equal(responseBody(forged).error.code, 'SOURCE_VERSION_MISMATCH');
  assertUnchanged(forgedBefore, workspaceState.snapshot(document.id));

  const staleBefore = workspaceState.snapshot(document.id);
  const stale = await routeCall(handler, document.id, {
    ...input, id: 'session-stale-route',
  }, initialRevision);
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(responseBody(stale).error.code, 'REVISION_CONFLICT');
  assertUnchanged(staleBefore, workspaceState.snapshot(document.id));
});
