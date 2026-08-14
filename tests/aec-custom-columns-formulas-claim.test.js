import assert from 'node:assert/strict';
import test from 'node:test';

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

function routeCall(handler, path, body) {
  return invoke(handler, {
    method: 'POST',
    url: path,
    headers: AUTH,
    body: JSON.stringify(body),
  });
}

async function upload(handler) {
  const response = await invoke(handler, {
    method: 'POST',
    url: '/api/documents',
    headers: { ...AUTH, 'content-type': 'application/pdf' },
    body: makeTextPdf('source-bound custom columns'),
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body).document;
}

function createCustomColumn(handler, documentId, input = {}, options = {}) {
  return routeCall(handler, `/api/documents/${documentId}/domain`, {
    group: 'AEC',
    operation: 'createCustomColumn',
    body: {
      input: {
        id: 'column-1',
        name: 'Area',
        formula: '+length * width + 2',
        ...input,
      },
      ...(options === undefined ? {} : { options }),
    },
  });
}

function evaluateCustomColumn(handler, documentId, values, extraBody = {}) {
  return routeCall(handler, `/api/documents/${documentId}/domain`, {
    group: 'AEC',
    operation: 'evaluateCustomColumn',
    body: {
      columnId: 'column-1',
      values,
      ...extraBody,
    },
  });
}

test('source-bound custom-column claims persist source, variables, and deterministic envelopes', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;

  const priorRevision = workspaceState.snapshot(document.id).revision;
  const created = await createCustomColumn(handler, document.id, {
    sourceSha256,
  }, { expectedRevision: priorRevision });
  assert.equal(created.statusCode, 200);
  const column = parseBody(created).result.namespaces.metadata.at(-1);
  assert.equal(column.sourceSha256, sourceSha256);
  assert.equal(column.basisRevision, priorRevision);
  assert.deepEqual(column.variables, ['length', 'width']);

  const evaluateRevision = workspaceState.snapshot(document.id).revision;
  const priorRecords = workspaceState.snapshot(document.id).namespaces.metadata.length;
  const evaluated = await evaluateCustomColumn(handler, document.id, {
    width: 4,
    length: 3,
  }, {
    sourceSha256,
    options: { expectedRevision: evaluateRevision },
  });
  assert.equal(evaluated.statusCode, 200, evaluated.body);
  const envelope = parseBody(evaluated).result;
  assert.equal(envelope.kind, 'source-bound-aec-custom-column-result');
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.columnId, column.id);
  assert.equal(envelope.name, 'Area');
  assert.equal(envelope.sourceSha256, sourceSha256);
  assert.equal(envelope.workspaceRevision, evaluateRevision);
  assert.deepEqual(envelope.variables, ['length', 'width']);
  assert.deepEqual(envelope.row, { length: 3, width: 4 });
  assert.equal(envelope.result, 14);
  assert.equal(Object.hasOwn(envelope, 'pdf'), false);
  assert.equal(Object.hasOwn(envelope, 'report'), false);

  const after = workspaceState.snapshot(document.id);
  assert.equal(after.revision, evaluateRevision);
  assert.equal(after.namespaces.metadata.length, priorRecords);
});

test('source-bound custom-column validates forged/stale requests and malformed rows', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const revision = workspaceState.snapshot(document.id).revision;

  const validCreate = await createCustomColumn(handler, document.id, {
    sourceSha256,
    id: 'column-valid',
  }, { expectedRevision: revision });
  assert.equal(validCreate.statusCode, 200);

  const currentRevision = workspaceState.snapshot(document.id).revision;
  const forged = await createCustomColumn(handler, document.id, {
    sourceSha256: SOURCE_B,
  }, { expectedRevision: currentRevision });
  assert.equal(forged.statusCode, 409);
  assert.equal(responseCode(forged), 'SOURCE_VERSION_MISMATCH');

  const stale = await createCustomColumn(handler, document.id, {
    sourceSha256,
  }, { expectedRevision: 0 });
  assert.equal(stale.statusCode, 409);
  assert.equal(responseCode(stale), 'REVISION_CONFLICT');

  const createResult = parseBody(validCreate).result.namespaces.metadata.at(-1);
  const evaluateRevision = workspaceState.snapshot(document.id).revision;

  const forgedEvaluate = await evaluateCustomColumn(handler, document.id, {
    length: 3,
    width: 4,
  }, {
    sourceSha256: SOURCE_B,
    options: { expectedRevision: evaluateRevision },
    columnId: createResult.id,
  });
  assert.equal(forgedEvaluate.statusCode, 409);
  assert.equal(responseCode(forgedEvaluate), 'SOURCE_VERSION_MISMATCH');

  const staleEvaluate = await evaluateCustomColumn(handler, document.id, {
    length: 3,
    width: 4,
  }, {
    sourceSha256,
    options: { expectedRevision: 0 },
    columnId: createResult.id,
  });
  assert.equal(staleEvaluate.statusCode, 409);
  assert.equal(responseCode(staleEvaluate), 'REVISION_CONFLICT');

  const missing = await evaluateCustomColumn(handler, document.id, {
    length: 3,
  }, {
    sourceSha256,
    options: { expectedRevision: evaluateRevision },
    columnId: createResult.id,
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(responseCode(missing), 'INVALID_INPUT');

  const extra = await evaluateCustomColumn(handler, document.id, {
    length: 3,
    width: 4,
    height: 1,
  }, {
    sourceSha256,
    options: { expectedRevision: evaluateRevision },
    columnId: createResult.id,
  });
  assert.equal(extra.statusCode, 400);
  assert.equal(responseCode(extra), 'INVALID_INPUT');

  const notNumber = await evaluateCustomColumn(handler, document.id, {
    length: '3',
    width: 4,
  }, {
    sourceSha256,
    options: { expectedRevision: evaluateRevision },
    columnId: createResult.id,
  });
  assert.equal(notNumber.statusCode, 400);
  assert.equal(responseCode(notNumber), 'INVALID_PARAMETER');

  const overflow = await evaluateCustomColumn(handler, document.id, {
    length: 10000000000001,
    width: 4,
  }, {
    sourceSha256,
    options: { expectedRevision: evaluateRevision },
    columnId: createResult.id,
  });
  assert.equal(overflow.statusCode, 400);
  assert.equal(responseCode(overflow), 'INVALID_PARAMETER');

  const nonIdentifier = await evaluateCustomColumn(handler, document.id, {
    length: 1,
    '2width': 4,
  }, {
    sourceSha256,
    options: { expectedRevision: evaluateRevision },
    columnId: createResult.id,
  });
  assert.equal(nonIdentifier.statusCode, 400);
  assert.equal(responseCode(nonIdentifier), 'INVALID_PARAMETER');

  const tooMany = await evaluateCustomColumn(handler, document.id, Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`x${index}`, 1])), {
    sourceSha256,
    options: { expectedRevision: evaluateRevision },
    columnId: createResult.id,
  });
  assert.equal(tooMany.statusCode, 400);
  assert.equal(responseCode(tooMany), 'INVALID_PARAMETER');
});

test('source-bound custom-column rejects formula divide-by-zero and unsupported token', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const revision = workspaceState.snapshot(document.id).revision;

  const created = await createCustomColumn(handler, document.id, {
    id: 'column-zero',
    formula: 'length / width',
    name: 'Zero',
    sourceSha256,
  }, { expectedRevision: revision });
  assert.equal(created.statusCode, 200);
  const zeroId = parseBody(created).result.namespaces.metadata.at(-1).id;

  const divideByZero = await evaluateCustomColumn(handler, document.id, {
    length: 4,
    width: 0,
  }, {
    sourceSha256,
    options: { expectedRevision: workspaceState.snapshot(document.id).revision },
    columnId: zeroId,
  });
  assert.equal(divideByZero.statusCode, 400);
  assert.equal(responseCode(divideByZero), 'FORMULA_DIVIDE_BY_ZERO');

  const token = await createCustomColumn(handler, document.id, {
    id: 'column-token',
    formula: 'globalThis.process',
    sourceSha256,
  }, { expectedRevision: workspaceState.snapshot(document.id).revision });
  assert.equal(token.statusCode, 400);
  assert.equal(responseCode(token), 'INVALID_FORMULA');

  const incomplete = await createCustomColumn(handler, document.id, {
    id: 'column-incomplete',
    formula: 'length +',
    sourceSha256,
  }, { expectedRevision: workspaceState.snapshot(document.id).revision });
  assert.equal(incomplete.statusCode, 400);
  assert.equal(responseCode(incomplete), 'INVALID_FORMULA');
});

test('legacy custom-column behavior remains unbounded without source bindings', () => {
  const store = new WorkspaceStateStore((value) => value === DOCUMENT_ID);
  const facade = new DomainFacade(store);
  let state = store.snapshot(DOCUMENT_ID);
  state = facade.execute(DOCUMENT_ID, {
    group: 'AEC',
    operation: 'createCustomColumn',
    body: {
      input: { id: 'legacy', name: 'Legacy area', formula: 'length * width + 2' },
      options: { expectedRevision: state.revision },
    },
  });
  const result = facade.execute(DOCUMENT_ID, {
    group: 'AEC',
    operation: 'evaluateCustomColumn',
    body: { columnId: 'legacy', values: { length: 3, width: 4 } },
  });

  assert.equal(typeof result, 'number');
  assert.equal(result, 14);
  const record = state.namespaces.metadata.at(-1);
  assert.equal(Object.hasOwn(record, 'sourceSha256'), false);
  assert.equal(Object.hasOwn(record, 'basisRevision'), false);
  assert.equal(Object.hasOwn(record, 'variables'), false);
});
