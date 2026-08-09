import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainFacade } from '../scripts/host/domain-facade.mjs';
import {
  fixture, invoke, makeTextPdf,
} from './support/host-router-fixture.js';

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
    body: makeTextPdf('source-bound AEC batch slip-sheet claim'),
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body).document;
}

function callPlan(handler, documentId, input, expectedRevision) {
  return invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/domain`,
    headers: AUTH,
    body: JSON.stringify({
      group: 'AEC',
      operation: 'createBatchPlan',
      body: { input, options: { expectedRevision } },
    }),
  });
}

function errorCode(response) {
  return JSON.parse(response.body).error.code;
}

function assertUnbound(record) {
  for (const field of ['sourceSha256', 'basisRevision', 'status']) {
    assert.equal(Object.hasOwn(record, field), false, `legacy record unexpectedly has ${field}`);
  }
}

test('source-bound slip-sheet plans are exact, local records and reject forged or stale bindings', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const initialRevision = workspaceState.snapshot(document.id).revision;

  const valid = await callPlan(handler, document.id, {
    id: 'batch-source',
    kind: 'slip-sheet',
    pairs: [{ from: 'sheet-a', to: 'sheet-b' }],
    sourceSha256,
  }, initialRevision);
  assert.equal(valid.statusCode, 200);
  const validWorkspace = JSON.parse(valid.body).result;
  const record = validWorkspace.namespaces.workflowRecords.at(-1);
  assert.deepEqual(Object.keys(record).sort(), [
    'basisRevision', 'createdAt', 'id', 'kind', 'pairs', 'sourceSha256', 'status', 'type',
  ]);
  assert.equal(record.id, 'batch-source');
  assert.equal(record.type, 'batch-plan');
  assert.equal(record.kind, 'slip-sheet');
  assert.deepEqual(record.pairs, [{ from: 'sheet-a', to: 'sheet-b' }]);
  assert.equal(record.sourceSha256, sourceSha256);
  assert.equal(record.basisRevision, initialRevision);
  assert.equal(record.status, 'planned');
  for (const field of ['pdf', 'artifact', 'output', 'applied', 'carryForward']) {
    assert.equal(Object.hasOwn(record, field), false, `forbidden field ${field} was persisted`);
  }

  const forgedRevision = workspaceState.snapshot(document.id).revision;
  const forged = await callPlan(handler, document.id, {
    kind: 'slip-sheet',
    pairs: [{ from: 'sheet-c', to: 'sheet-d' }],
    sourceSha256: SOURCE_B,
  }, forgedRevision);
  assert.equal(forged.statusCode, 409);
  assert.equal(errorCode(forged), 'SOURCE_VERSION_MISMATCH');

  const stale = await callPlan(handler, document.id, {
    kind: 'slip-sheet',
    pairs: [{ from: 'sheet-c', to: 'sheet-d' }],
    sourceSha256,
  }, initialRevision);
  assert.equal(stale.statusCode, 409);
  assert.equal(errorCode(stale), 'REVISION_CONFLICT');
});

test('source-bound batch plans reject link kind and malformed pairs without mutation', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const expectedRevision = workspaceState.snapshot(document.id).revision;
  const invalidInputs = [
    { kind: 'slip-sheet', pairs: [], expectedCode: 'INVALID_PARAMETER' },
    {
      kind: 'slip-sheet',
      pairs: [{ from: 'sheet-a', to: 'sheet-b' }, { from: 'sheet-a', to: 'sheet-c' }],
      expectedCode: 'INVALID_PLAN',
    },
    {
      kind: 'slip-sheet',
      pairs: [{ from: 'sheet-a', to: 'sheet-b' }, { from: 'sheet-c', to: 'sheet-b' }],
      expectedCode: 'INVALID_PLAN',
    },
    { kind: 'slip-sheet', pairs: [{ from: 'sheet-a', to: 'sheet-a' }], expectedCode: 'INVALID_PLAN' },
    {
      kind: 'slip-sheet',
      pairs: [{ from: 'sheet-a', to: 'sheet-b', carryForward: true }],
      expectedCode: 'INVALID_PARAMETER',
    },
    { kind: 'link', pairs: [{ from: 'sheet-a', to: 'sheet-b' }], expectedCode: 'INVALID_PLAN' },
  ];

  for (const input of invalidInputs) {
    const before = workspaceState.snapshot(document.id);
    const { expectedCode, ...planInput } = input;
    const response = await callPlan(handler, document.id, { ...planInput, sourceSha256 }, expectedRevision);
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response), expectedCode);
    const after = workspaceState.snapshot(document.id);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.namespaces.workflowRecords, before.namespaces.workflowRecords);
  }
});

test('direct DomainFacade legacy link and slip-sheet plans remain unbound', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const facade = new DomainFacade(workspaceState);
  let expectedRevision = workspaceState.snapshot(document.id).revision;

  const linkWorkspace = facade.execute(document.id, {
    group: 'AEC',
    operation: 'createBatchPlan',
    body: {
      input: { kind: 'link', pairs: [{ from: 'sheet-a', to: 'sheet-b' }] },
      options: { expectedRevision },
    },
  });
  const link = linkWorkspace.namespaces.workflowRecords.at(-1);
  assert.equal(link.kind, 'link');
  assertUnbound(link);
  expectedRevision = linkWorkspace.revision;

  const slipSheetWorkspace = facade.execute(document.id, {
    group: 'AEC',
    operation: 'createBatchPlan',
    body: {
      input: { kind: 'slip-sheet', pairs: [{ from: 'sheet-c', to: 'sheet-d' }] },
      options: { expectedRevision },
    },
  });
  const slipSheet = slipSheetWorkspace.namespaces.workflowRecords.at(-1);
  assert.equal(slipSheet.kind, 'slip-sheet');
  assertUnbound(slipSheet);
  assert.equal(store.getDocument(document.id).sha256.length, 64);
});
