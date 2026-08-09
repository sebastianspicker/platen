import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fixture,
  invoke,
  makeTextPdf,
  PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE,
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
    body: makeTextPdf('revision workflow claim source'),
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body).document;
}

function callDomain(handler, documentId, operation, body) {
  return invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/domain`,
    headers: AUTH,
    body: JSON.stringify({ group: 'collaboration', operation, body }),
  });
}

function createRevision(handler, documentId, sourceSha256, expectedRevision) {
  return callDomain(handler, documentId, 'createRevision', {
    input: {
      id: 'revision-1',
      label: 'Draft',
      sourceSha256,
    },
    options: { expectedRevision },
  });
}

function transitionRevision(handler, documentId, revisionId, nextStatus, sourceSha256, expectedRevision) {
  return callDomain(handler, documentId, 'transitionRevision', {
    revisionId,
    nextStatus,
    sourceSha256,
    options: { expectedRevision },
  });
}

function assertNoArtifactClaims(record) {
  assert.equal(Object.hasOwn(record, 'artifact'), false);
  assert.equal(Object.hasOwn(record, 'networkLink'), false);
  assert.equal(Object.hasOwn(record, 'pdf'), false);
}

test('authenticated source-bound revision status transitions draft -> issued -> superseded', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;

  const createResponse = await createRevision(handler, document.id, sourceSha256, workspaceState.snapshot(document.id).revision);
  assert.equal(createResponse.statusCode, 200);
  const createdWorkspace = JSON.parse(createResponse.body).result;
  const draft = createdWorkspace.namespaces.workflowRecords.at(-1);
  assert.equal(draft.type, 'revision-status');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.sourceSha256, sourceSha256);
  assert.equal(draft.basisRevision, 0);
  assertNoArtifactClaims(draft);

  const issuedResponse = await transitionRevision(
    handler,
    document.id,
    draft.id,
    'issued',
    sourceSha256,
    createdWorkspace.revision,
  );
  assert.equal(issuedResponse.statusCode, 200);
  const issuedWorkspace = JSON.parse(issuedResponse.body).result;
  const issued = issuedWorkspace.namespaces.workflowRecords.at(-1);
  assert.equal(issued.status, 'issued');
  assert.equal(issued.basisRevision, createdWorkspace.revision);
  assertNoArtifactClaims(issued);

  const supersededResponse = await transitionRevision(
    handler,
    document.id,
    issued.id,
    'superseded',
    sourceSha256,
    issuedWorkspace.revision,
  );
  assert.equal(supersededResponse.statusCode, 200);
  const supersededWorkspace = JSON.parse(supersededResponse.body).result;
  const superseded = supersededWorkspace.namespaces.workflowRecords.at(-1);
  assert.equal(superseded.status, 'superseded');
  assert.equal(superseded.basisRevision, issuedWorkspace.revision);
  assertNoArtifactClaims(superseded);
});

test('source-bound revision creation rejects forged source digests and stale revisions', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const currentRevision = workspaceState.snapshot(document.id).revision;

  const forged = await createRevision(handler, document.id, SOURCE_B, currentRevision);
  assert.equal(forged.statusCode, 409);
  assert.equal(JSON.parse(forged.body).error.code, 'SOURCE_VERSION_MISMATCH');

  const valid = await createRevision(handler, document.id, sourceSha256, currentRevision);
  assert.equal(valid.statusCode, 200);
  const stale = await createRevision(handler, document.id, sourceSha256, 0);
  assert.equal(stale.statusCode, 409);
  assert.equal(JSON.parse(stale.body).error.code, 'REVISION_CONFLICT');
});

test('source-bound revision transition rejects invalid status transitions', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const initial = await createRevision(handler, document.id, sourceSha256, workspaceState.snapshot(document.id).revision);
  const created = JSON.parse(initial.body).result;
  const revision = created.namespaces.workflowRecords.at(-1);

  const invalid = await transitionRevision(handler, document.id, revision.id, 'draft', sourceSha256, created.revision);
  assert.equal(invalid.statusCode, 409);
  assert.equal(JSON.parse(invalid.body).error.code, 'INVALID_STATUS_TRANSITION');
});

test('portable project bundle round-trip preserves source-bound draft revisions and allows post-import transition', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;

  const created = await createRevision(handler, document.id, sourceSha256, workspaceState.snapshot(document.id).revision);
  assert.equal(created.statusCode, 200);
  const originalWorkspace = JSON.parse(created.body).result;
  const originalRevision = originalWorkspace.namespaces.workflowRecords.at(-1);
  assert.equal(originalRevision.status, 'draft');
  assert.equal(originalRevision.sourceSha256, sourceSha256);

  const exported = await invoke(handler, {
    url: `/api/documents/${document.id}/portable-project-bundle`,
    headers: { 'x-platen-token': 'test-session-token' },
  });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.headers['Content-Type'], PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE);

  const imported = await invoke(handler, {
    method: 'POST',
    url: '/api/project-bundles',
    headers: {
      origin: 'http://127.0.0.1:4173',
      'content-type': PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE,
      'x-platen-token': 'test-session-token',
    },
    body: exported.body,
  });
  assert.equal(imported.statusCode, 201);

  const importedResult = JSON.parse(imported.body).result;
  const importedWorkspace = importedResult.workspace;
  const importedDocument = importedResult.document;
  const importedRevision = importedWorkspace.namespaces.workflowRecords.at(-1);
  assert.equal(importedRevision.type, 'revision-status');
  assert.equal(importedRevision.status, 'draft');
  assert.equal(importedRevision.sourceSha256, sourceSha256);
  assert.equal(importedRevision.basisRevision, originalRevision.basisRevision);
  assertNoArtifactClaims(importedRevision);

  const transitioned = await transitionRevision(
    handler,
    importedDocument.id,
    importedRevision.id,
    'issued',
    importedDocument.sha256,
    importedWorkspace.revision,
  );
  assert.equal(transitioned.statusCode, 200);
  const transitionedWorkspace = JSON.parse(transitioned.body).result;
  const transitionedRevision = transitionedWorkspace.namespaces.workflowRecords.find((item) => item.id === importedRevision.id);
  assert.equal(transitionedRevision.status, 'issued');
  assert.equal(transitionedRevision.basisRevision, importedWorkspace.revision);
  assertNoArtifactClaims(transitionedRevision);
});
