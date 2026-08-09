import assert from 'node:assert/strict';
import test from 'node:test';

import { DomainFacade } from '../scripts/host/domain-facade.mjs';
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

async function upload(handler) {
  const response = await invoke(handler, {
    method: 'POST', url: '/api/documents',
    headers: { ...AUTH, 'content-type': 'application/pdf' },
    body: makeTextPdf('source-bound markup list'),
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body).document;
}

function callDomain(handler, documentId, operation, body) {
  return invoke(handler, {
    method: 'POST', url: `/api/documents/${documentId}/domain`, headers: AUTH,
    body: JSON.stringify({ group: 'AEC', operation, body }),
  });
}

function markupInput(sourceSha256, id, markupType, status, page) {
  return { id, type: markupType, status, page, properties: {}, sourceSha256 };
}

async function createMarkup(handler, documentId, sourceSha256, revision, id, type, status, page) {
  return callDomain(handler, documentId, 'createMarkup', {
    input: markupInput(sourceSha256, id, type, status, page),
    options: { expectedRevision: revision },
  });
}

function listMarkups(handler, documentId, sourceSha256, revision, filters = {}) {
  return callDomain(handler, documentId, 'listMarkups', {
    query: { sourceSha256, expectedRevision: revision, ...filters },
  });
}

test('authenticated markup creation binds trusted source and current workspace revision', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const revision = workspaceState.snapshot(document.id).revision;

  const valid = await createMarkup(handler, document.id, sourceSha256, revision, 'markup-1', 'cloud', 'open', 1);
  assert.equal(valid.statusCode, 200);
  const record = JSON.parse(valid.body).result.namespaces.annotations.at(-1);
  assert.equal(record.sourceSha256, sourceSha256);
  assert.equal(record.basisRevision, revision);
  assert.equal(Object.hasOwn(record, 'pdf'), false);

  const current = workspaceState.snapshot(document.id).revision;
  const forged = await createMarkup(handler, document.id, SOURCE_B, current, 'forged', 'cloud', 'open', 1);
  assert.equal(forged.statusCode, 409);
  assert.equal(JSON.parse(forged.body).error.code, 'SOURCE_VERSION_MISMATCH');
  const stale = await createMarkup(handler, document.id, sourceSha256, 0, 'stale', 'cloud', 'open', 1);
  assert.equal(stale.statusCode, 409);
  assert.equal(JSON.parse(stale.body).error.code, 'REVISION_CONFLICT');
});

test('markup list is source-bound, revision-bound, filtered, summarized, and deterministic', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const values = [
    ['z-cloud', 'cloud', 'open', 3],
    ['a-arrow', 'arrow', 'open', 1],
    ['m-cloud', 'cloud', 'closed', 2],
  ];
  for (const [id, type, status, page] of values) {
    const response = await createMarkup(
      handler, document.id, sourceSha256, workspaceState.snapshot(document.id).revision, id, type, status, page,
    );
    assert.equal(response.statusCode, 200);
  }
  let state = workspaceState.snapshot(document.id);
  state = workspaceState.createEntity(document.id, 'annotations', {
    id: 'foreign', type: 'markup', markupType: 'cloud', status: 'open', page: 1,
    properties: {}, sourceSha256: SOURCE_B, basisRevision: state.revision,
    createdAt: '2026-08-02T00:00:00.000Z',
  }, { expectedRevision: state.revision });

  const open = await listMarkups(handler, document.id, sourceSha256, state.revision, { status: 'open' });
  assert.equal(open.statusCode, 200, open.body.toString());
  const result = JSON.parse(open.body).result;
  assert.equal(result.kind, 'source-bound-aec-markup-list');
  assert.equal(result.sourceSha256, sourceSha256);
  assert.equal(result.workspaceRevision, state.revision);
  assert.equal(result.count, 2);
  assert.deepEqual(result.markups.map((record) => record.id), ['a-arrow', 'z-cloud']);
  assert.deepEqual(result.byType, { arrow: 1, cloud: 1 });
  assert.deepEqual(result.byStatus, { open: 2 });
  assert.equal(result.markups.some((record) => record.id === 'foreign'), false);
  assert.equal(Object.hasOwn(result, 'pdf'), false);

  const filtered = await listMarkups(handler, document.id, sourceSha256, state.revision, {
    type: 'cloud', status: 'open', page: 3,
  });
  assert.equal(filtered.statusCode, 200);
  assert.deepEqual(JSON.parse(filtered.body).result.markups.map((record) => record.id), ['z-cloud']);

  const forged = await listMarkups(handler, document.id, SOURCE_B, state.revision, { status: 'open' });
  assert.equal(forged.statusCode, 409);
  assert.equal(JSON.parse(forged.body).error.code, 'SOURCE_VERSION_MISMATCH');
  const stale = await listMarkups(handler, document.id, sourceSha256, 0, { status: 'open' });
  assert.equal(stale.statusCode, 409);
  assert.equal(JSON.parse(stale.body).error.code, 'REVISION_CONFLICT');
});

test('direct domain calls retain legacy arrays while exact calls return a bounded envelope', () => {
  const store = new WorkspaceStateStore((value) => value === DOCUMENT_ID);
  const facade = new DomainFacade(store);
  let state = store.snapshot(DOCUMENT_ID);
  state = facade.execute(DOCUMENT_ID, {
    group: 'AEC', operation: 'createMarkup',
    body: { input: { id: 'legacy', type: 'note', status: 'open', page: 1, properties: {} }, options: { expectedRevision: state.revision } },
  });
  assert.equal(Array.isArray(facade.execute(DOCUMENT_ID, {
    group: 'AEC', operation: 'listMarkups', body: { query: { status: 'open' } },
  })), true);

  state = facade.execute(DOCUMENT_ID, {
    group: 'AEC', operation: 'createMarkup',
    body: { input: markupInput(SOURCE_A, 'bound', 'cloud', 'open', 2), options: { expectedRevision: state.revision } },
  });
  const exact = facade.execute(DOCUMENT_ID, {
    group: 'AEC', operation: 'listMarkups',
    body: { query: { sourceSha256: SOURCE_A, expectedRevision: state.revision, status: 'open' } },
  });
  assert.equal(Array.isArray(exact), false);
  assert.equal(exact.count, 1);
  assert.deepEqual(exact.markups.map((record) => record.id), ['bound']);
});
