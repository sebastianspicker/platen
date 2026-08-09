import assert from 'node:assert/strict';
import test from 'node:test';

import { measurementToolset } from '../scripts/host/domains/aec-measurement-toolset.mjs';
import { fixture, invoke, makeTextPdf } from './support/host-router-fixture.js';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_DIGEST = 'a'.repeat(64);
const SOURCE_B = 'b'.repeat(64);
const AUTH = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-platen-token': 'test-session-token',
});

function responseBody(response) {
  return JSON.parse(response.body);
}

async function upload(handler) {
  const response = await invoke(handler, {
    method: 'POST',
    url: '/api/documents',
    headers: { ...AUTH, 'content-type': 'application/pdf' },
    body: makeTextPdf('source-bound measurement toolset'),
  });
  assert.equal(response.statusCode, 201);
  return responseBody(response).document;
}

function routeCall(handler, documentId, sourceSha256, expectedRevision, input = {}) {
  return invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/domain`,
    headers: AUTH,
    body: JSON.stringify({
      group: 'AEC',
      operation: 'measurementToolset',
      body: {
        input: { sourceSha256, ...input },
        options: { expectedRevision },
      },
    }),
  });
}

function domainWithRevision(revision = 4) {
  const state = { revision };
  return {
    snapshot(documentId) {
      assert.equal(documentId, DOCUMENT_ID);
      return { revision: state.revision };
    },
    state,
  };
}

test('source-bound measurement toolset returns exactly the local SI catalog without mutation', () => {
  const domain = domainWithRevision();
  const before = structuredClone(domain.state);
  const result = measurementToolset(domain, DOCUMENT_ID, { sourceSha256: SOURCE_DIGEST }, { expectedRevision: 4 });

  assert.deepEqual(result, {
    kind: 'source-bound-aec-measurement-toolset',
    schemaVersion: 1,
    sourceSha256: SOURCE_DIGEST,
    workspaceRevision: 4,
    tools: [
      { id: 'distance', kind: 'distance', dimension: 'length', siUnit: 'm' },
      { id: 'perimeter', kind: 'perimeter', dimension: 'length', siUnit: 'm' },
      { id: 'area', kind: 'area', dimension: 'area', siUnit: 'm2' },
      { id: 'count', kind: 'count', dimension: 'count', siUnit: 'count' },
    ],
  });
  assert.deepEqual(domain.state, before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.tools), true);
  assert.equal(Object.isFrozen(result.tools[0]), true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('measurement toolset rejects stale, malformed, and extra-key requests without mutation', () => {
  const domain = domainWithRevision();
  const before = structuredClone(domain.state);

  assert.throws(
    () => measurementToolset(domain, DOCUMENT_ID, { sourceSha256: SOURCE_DIGEST }, { expectedRevision: 3 }),
    { code: 'REVISION_CONFLICT', status: 409 },
  );
  assert.throws(
    () => measurementToolset(domain, DOCUMENT_ID, { sourceSha256: 'forged' }, { expectedRevision: 4 }),
    { code: 'INVALID_DIGEST' },
  );
  assert.throws(
    () => measurementToolset(domain, DOCUMENT_ID, { sourceSha256: SOURCE_DIGEST, tools: ['volume'] }, { expectedRevision: 4 }),
    { code: 'INVALID_INPUT' },
  );
  assert.throws(
    () => measurementToolset(domain, DOCUMENT_ID, { sourceSha256: SOURCE_DIGEST }, { expectedRevision: 4, tools: ['distance'] }),
    { code: 'INVALID_INPUT' },
  );
  assert.deepEqual(domain.state, before);
});

test('measurement toolset exposes no unsupported kinds or caller-defined tools', () => {
  const result = measurementToolset(domainWithRevision(), DOCUMENT_ID, { sourceSha256: SOURCE_DIGEST }, { expectedRevision: 4 });
  assert.deepEqual(result.tools.map((tool) => tool.kind), ['distance', 'perimeter', 'area', 'count']);
  assert.equal(result.tools.some((tool) => ['volume', 'angle', 'radius'].includes(tool.kind)), false);
  assert.equal(result.tools.some((tool) => tool.id === 'caller-defined'), false);
});

test('authenticated measurement toolset route binds trusted source and revision without mutation', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const before = workspaceState.snapshot(document.id);

  const valid = await routeCall(handler, document.id, sourceSha256, before.revision);
  assert.equal(valid.statusCode, 200, valid.body);
  const result = responseBody(valid).result;
  assert.equal(result.sourceSha256, sourceSha256);
  assert.equal(result.workspaceRevision, before.revision);
  assert.deepEqual(result.tools.map((tool) => tool.kind), ['distance', 'perimeter', 'area', 'count']);
  assert.deepEqual(workspaceState.snapshot(document.id), before);

  const forged = await routeCall(handler, document.id, SOURCE_B, before.revision);
  assert.equal(forged.statusCode, 409, forged.body);
  assert.equal(responseBody(forged).error.code, 'SOURCE_VERSION_MISMATCH');
  assert.deepEqual(workspaceState.snapshot(document.id), before);

  const stale = await routeCall(handler, document.id, sourceSha256, before.revision + 1);
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(responseBody(stale).error.code, 'REVISION_CONFLICT');
  assert.deepEqual(workspaceState.snapshot(document.id), before);

  const extra = await routeCall(handler, document.id, sourceSha256, before.revision, {
    tools: ['distance'],
  });
  assert.equal(extra.statusCode, 400, extra.body);
  assert.equal(responseBody(extra).error.code, 'INVALID_PARAMETER');
  assert.deepEqual(workspaceState.snapshot(document.id), before);
});
