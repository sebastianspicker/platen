import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DomainFacade } from '../scripts/host/domain-facade.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { fixture, invoke, makeTextPdf } from './support/host-router-fixture.js';

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
    body: makeTextPdf('source-bound markup toolset'),
  });
  assert.equal(response.statusCode, 201);
  return parseBody(response).document;
}

function createToolset(handler, documentId, sourceSha256, expectedRevision, overrides = {}) {
  return invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/domain`,
    headers: AUTH,
    body: JSON.stringify({
      group: 'AEC',
      operation: 'createToolset',
      body: {
        input: {
          id: 'toolset-bound',
          name: 'Markup tools',
          tools: ['cloud', 'arrow'],
          sourceSha256,
          ...overrides,
        },
        options: { expectedRevision },
      },
    }),
  });
}

function assertUnchanged(before, after) {
  assert.deepEqual(after, before);
}

test('authenticated source-bound markup toolsets persist exact source and basis metadata', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const expectedRevision = workspaceState.snapshot(document.id).revision;
  const sourceBytes = await readFile(store.getSourcePath(document.id));
  const beforeWorkspace = workspaceState.snapshot(document.id);

  const response = await createToolset(handler, document.id, sourceSha256, expectedRevision);
  assert.equal(response.statusCode, 200, response.body);
  const record = parseBody(response).result.namespaces.metadata.at(-1);
  assert.deepEqual(Object.keys(record), [
    'id', 'type', 'name', 'tools', 'sourceSha256', 'basisRevision', 'createdAt',
  ]);
  assert.equal(record.id, 'toolset-bound');
  assert.equal(record.type, 'toolset');
  assert.equal(record.name, 'Markup tools');
  assert.deepEqual(record.tools, ['cloud', 'arrow']);
  assert.equal(record.sourceSha256, sourceSha256);
  assert.equal(record.basisRevision, expectedRevision);
  for (const forbidden of ['pdf', 'artifact', 'output', 'remote', 'remoteAccess', 'remoteCollaboration']) {
    assert.equal(Object.hasOwn(record, forbidden), false, `unexpected ${forbidden} field`);
  }
  assert.deepEqual(parseBody(response).result.namespaces.annotations, beforeWorkspace.namespaces.annotations);
  assert.deepEqual(await readFile(store.getSourcePath(document.id)), sourceBytes);
});

test('source-bound markup toolsets enforce the 1..50 unique bounded tool-name contract', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const maximumTools = Array.from({ length: 50 }, (_, index) => `tool-${index + 1}`);
  const initialRevision = workspaceState.snapshot(document.id).revision;

  const maximum = await createToolset(handler, document.id, sourceSha256, initialRevision, {
    tools: maximumTools,
  });
  assert.equal(maximum.statusCode, 200, maximum.body);
  assert.deepEqual(parseBody(maximum).result.namespaces.metadata.at(-1).tools, maximumTools);

  const tooManyBefore = workspaceState.snapshot(document.id);
  const tooMany = await createToolset(handler, document.id, sourceSha256, tooManyBefore.revision, {
    tools: [...maximumTools, 'tool-51'],
  });
  assert.equal(tooMany.statusCode, 400);
  assert.equal(responseCode(tooMany), 'INVALID_LIST');
  assertUnchanged(tooManyBefore, workspaceState.snapshot(document.id));

  const emptyBefore = workspaceState.snapshot(document.id);
  const empty = await createToolset(handler, document.id, sourceSha256, emptyBefore.revision, { tools: [] });
  assert.equal(empty.statusCode, 400);
  assert.equal(responseCode(empty), 'INVALID_TOOLSET');
  assertUnchanged(emptyBefore, workspaceState.snapshot(document.id));

  const overlongBefore = workspaceState.snapshot(document.id);
  const overlong = await createToolset(handler, document.id, sourceSha256, overlongBefore.revision, {
    tools: ['x'.repeat(81)],
  });
  assert.equal(overlong.statusCode, 400);
  assert.equal(responseCode(overlong), 'INVALID_INPUT');
  assertUnchanged(overlongBefore, workspaceState.snapshot(document.id));
});

test('source-bound markup toolsets reject forged, stale, and malformed requests without mutation', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const initialRevision = workspaceState.snapshot(document.id).revision;
  const valid = await createToolset(handler, document.id, sourceSha256, initialRevision);
  assert.equal(valid.statusCode, 200, valid.body);

  const current = workspaceState.snapshot(document.id);
  const forged = await createToolset(handler, document.id, SOURCE_B, current.revision);
  assert.equal(forged.statusCode, 409);
  assert.equal(responseCode(forged), 'SOURCE_VERSION_MISMATCH');
  assertUnchanged(current, workspaceState.snapshot(document.id));

  const stale = await createToolset(handler, document.id, sourceSha256, initialRevision);
  assert.equal(stale.statusCode, 409);
  assert.equal(responseCode(stale), 'REVISION_CONFLICT');
  assertUnchanged(current, workspaceState.snapshot(document.id));

  const malformed = [
    { tools: [] },
    { tools: ['cloud', 'cloud'] },
    { tools: ['x'.repeat(81)] },
  ];
  for (const overrides of malformed) {
    const before = workspaceState.snapshot(document.id);
    const result = await createToolset(handler, document.id, sourceSha256, before.revision, overrides);
    assert.equal(result.statusCode, 400, result.body);
    assertUnchanged(before, workspaceState.snapshot(document.id));
  }
  const beforeExtra = workspaceState.snapshot(document.id);
  const extra = await createToolset(handler, document.id, sourceSha256, beforeExtra.revision, { extra: true });
  assert.equal(extra.statusCode, 400);
  assert.equal(responseCode(extra), 'INVALID_PARAMETER');
  assertUnchanged(beforeExtra, workspaceState.snapshot(document.id));
  const duplicate = await createToolset(handler, document.id, sourceSha256, current.revision, {
    tools: ['cloud', 'cloud'],
  });
  assert.equal(responseCode(duplicate), 'INVALID_TOOLSET');
});

test('direct DomainFacade legacy toolset creation remains unbound', () => {
  const documentId = '11111111-1111-4111-8111-111111111111';
  const store = new WorkspaceStateStore((value) => value === documentId);
  const facade = new DomainFacade(store);
  const before = store.snapshot(documentId);
  const result = facade.execute(documentId, {
    group: 'AEC',
    operation: 'createToolset',
    body: {
      input: { id: 'legacy-toolset', name: 'Legacy tools', tools: ['cloud'] },
      options: { expectedRevision: before.revision },
    },
  });
  const record = result.namespaces.metadata.at(-1);
  assert.deepEqual(Object.keys(record), ['id', 'type', 'name', 'tools', 'createdAt']);
  assert.equal(Object.hasOwn(record, 'sourceSha256'), false);
  assert.equal(Object.hasOwn(record, 'basisRevision'), false);
});
