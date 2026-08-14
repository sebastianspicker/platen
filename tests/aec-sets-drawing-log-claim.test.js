import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { DomainFacade } from '../scripts/host/domain-facade.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { fixture, invoke, makeTextPdf } from './support/host-router-fixture.js';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_B = 'b'.repeat(64);
const AUTH = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-platen-token': 'test-session-token',
});

function parseBody(response) {
  return JSON.parse(response.body);
}

function responseCode(response) {
  return parseBody(response).error.code;
}

async function upload(handler) {
  const response = await invoke(handler, {
    method: 'POST',
    url: '/api/documents',
    headers: { ...AUTH, 'content-type': 'application/pdf' },
    body: makeTextPdf('source-bound AEC drawing set and initial log'),
  });
  assert.equal(response.statusCode, 201);
  return parseBody(response).document;
}

function createDrawingSet(handler, documentId, sourceSha256, expectedRevision, overrides = {}) {
  return invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/domain`,
    headers: AUTH,
    body: JSON.stringify({
      group: 'AEC',
      operation: 'createDrawingSet',
      body: {
        input: {
          id: 'set-bound',
          name: 'Issued set',
          sheets: ['A-100', 'A-101', 'A-102'],
          initialLog: { revisionLabel: 'IFC', date: '2026-08-02' },
          sourceSha256,
          ...overrides,
        },
        options: { expectedRevision },
      },
    }),
  });
}

test('authenticated source-bound drawing sets persist one local set and one initial log entry', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const expectedRevision = workspaceState.snapshot(document.id).revision;
  const sourceBytes = await readFile(store.getSourcePath(document.id));

  const response = await createDrawingSet(handler, document.id, sourceSha256, expectedRevision);
  assert.equal(response.statusCode, 200, response.body);
  const result = parseBody(response).result;
  const record = result.namespaces.reviewRecords.at(-1);
  assert.deepEqual(Object.keys(record).sort(), [
    'basisRevision', 'createdAt', 'id', 'initialLog', 'name', 'sheets', 'sourceSha256', 'type',
  ]);
  assert.equal(record.id, 'set-bound');
  assert.equal(record.type, 'drawing-set');
  assert.equal(record.name, 'Issued set');
  assert.deepEqual(record.sheets, ['A-100', 'A-101', 'A-102']);
  assert.deepEqual(record.initialLog, { revisionLabel: 'IFC', date: '2026-08-02' });
  assert.equal(record.sourceSha256, sourceSha256);
  assert.equal(record.basisRevision, expectedRevision);
  for (const forbidden of ['pdf', 'artifact', 'output', 'pages', 'remote', 'remoteCollaboration']) {
    assert.equal(Object.hasOwn(record, forbidden), false, `unexpected ${forbidden} field`);
  }
  assert.deepEqual(await readFile(store.getSourcePath(document.id)), sourceBytes);
});

test('source-bound drawing sets enforce sheet and initial-log bounds without mutation', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  let expectedRevision = workspaceState.snapshot(document.id).revision;
  const maximumSheets = Array.from({ length: 100 }, (_value, index) => `A-${index + 1}`);
  const maximum = await createDrawingSet(handler, document.id, sourceSha256, expectedRevision, {
    id: 'set-maximum',
    sheets: maximumSheets,
  });
  assert.equal(maximum.statusCode, 200, maximum.body);
  assert.deepEqual(parseBody(maximum).result.namespaces.reviewRecords.at(-1).sheets, maximumSheets);
  expectedRevision = workspaceState.snapshot(document.id).revision;
  const cases = [
    { sheets: [], expectedCode: 'INVALID_DRAWING_SET' },
    { sheets: ['A-100', ' A-100 '], expectedCode: 'INVALID_DRAWING_SET' },
    { sheets: Array.from({ length: 101 }, (_value, index) => `A-${index}`), expectedCode: 'INVALID_LIST' },
    { initialLog: { revisionLabel: 'IFC', date: '2026-02-30' }, expectedCode: 'INVALID_DRAWING_SET' },
    { initialLog: { revisionLabel: 'IFC', date: '2026-08-02', note: 'extra' }, expectedCode: 'INVALID_PARAMETER' },
  ];

  for (const { expectedCode, ...overrides } of cases) {
    const before = workspaceState.snapshot(document.id);
    const response = await createDrawingSet(handler, document.id, sourceSha256, expectedRevision, overrides);
    assert.equal(response.statusCode, 400, response.body.toString());
    assert.equal(responseCode(response), expectedCode);
    assert.deepEqual(workspaceState.snapshot(document.id), before);
    assert.equal(store.getDocument(document.id).sha256, sourceSha256);
  }
});

test('source-bound drawing sets reject forged and stale bindings without mutation', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const initialRevision = workspaceState.snapshot(document.id).revision;

  const forgedBefore = workspaceState.snapshot(document.id);
  const forged = await createDrawingSet(handler, document.id, SOURCE_B, initialRevision);
  assert.equal(forged.statusCode, 409);
  assert.equal(responseCode(forged), 'SOURCE_VERSION_MISMATCH');
  assert.deepEqual(workspaceState.snapshot(document.id), forgedBefore);

  const valid = await createDrawingSet(handler, document.id, sourceSha256, initialRevision);
  assert.equal(valid.statusCode, 200, valid.body);
  const staleBefore = workspaceState.snapshot(document.id);
  const stale = await createDrawingSet(handler, document.id, sourceSha256, initialRevision, { id: 'set-stale' });
  assert.equal(stale.statusCode, 409);
  assert.equal(responseCode(stale), 'REVISION_CONFLICT');
  assert.deepEqual(workspaceState.snapshot(document.id), staleBefore);
});

test('legacy DomainFacade drawing sets remain source-unbound', () => {
  const store = new WorkspaceStateStore((value) => value === DOCUMENT_ID);
  const facade = new DomainFacade(store);
  const before = store.snapshot(DOCUMENT_ID);
  const result = facade.execute(DOCUMENT_ID, {
    group: 'AEC',
    operation: 'createDrawingSet',
    body: {
      input: { id: 'legacy-set', name: 'Legacy set', sheets: ['A-100'] },
      options: { expectedRevision: before.revision },
    },
  });
  const record = result.namespaces.reviewRecords.at(-1);
  assert.deepEqual(Object.keys(record), ['id', 'type', 'name', 'sheets', 'createdAt']);
  assert.equal(record.type, 'drawing-set');
  assert.equal(Object.hasOwn(record, 'sourceSha256'), false);
  assert.equal(Object.hasOwn(record, 'basisRevision'), false);
  assert.equal(Object.hasOwn(record, 'initialLog'), false);
});

test('source-bound drawing-set records reject non-plain initial logs before mutation', () => {
  const store = new WorkspaceStateStore((value) => value === DOCUMENT_ID);
  const facade = new DomainFacade(store);
  const before = store.snapshot(DOCUMENT_ID);
  const initialLog = Object.assign(Object.create(null), {
    revisionLabel: 'IFC', date: '2026-08-02',
  });
  assert.throws(() => facade.execute(DOCUMENT_ID, {
    group: 'AEC',
    operation: 'createDrawingSet',
    body: {
      input: {
        id: 'non-plain-log',
        name: 'Set',
        sheets: ['A-100'],
        initialLog,
        sourceSha256: 'a'.repeat(64),
      },
      options: { expectedRevision: before.revision },
    },
  }), { code: 'INVALID_DOMAIN_REQUEST' });
  assert.deepEqual(store.snapshot(DOCUMENT_ID), before);
});
