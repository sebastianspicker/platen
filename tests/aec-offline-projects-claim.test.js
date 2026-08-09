import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';

import { DocumentStore } from '../scripts/host/document-store.mjs';
import { ProjectBundleService } from '../scripts/host/project-bundle-service.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { createDomainWorkspaceController } from '../src/controllers/domain-workspace-controller.js';
import {
  fixture,
  invoke,
  makeTextPdf,
  PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE,
  PROJECT_BUNDLE_MEDIA_TYPE,
} from './support/host-router-fixture.js';

class TestFile extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = name;
  }
}

function makeControllerState() {
  return {
    analysis: { documentId: 'document-1', sha256: 'a'.repeat(64) },
    document: { isOpen: true, name: 'plan.pdf' },
    domainOperations: { review: { createAnnotation: { supported: true } } },
    selectedDomainOperation: null,
    domainPayload: '{}',
    domainRevision: 3,
    domainBusy: false,
    domainError: null,
    domainResult: null,
    busyAction: null,
    canCancel: false,
  };
}

function buildController({ state, operation, operationIsCurrent, client }) {
  const announcements = [];
  const downloads = [];
  const documentOperations = { activeController: null };
  const controller = createDomainWorkspaceController({
    state,
    client,
    getDocumentOperations: () => documentOperations,
    connectLocalHost: async () => {},
    openFile: async () => {},
    removeHostDocument: async () => {},
    captureOperation: () => operation,
    operationIsCurrent,
    finishOperation: () => {
      state.domainBusy = false;
    },
    syncAecRecordIds: () => {},
    triggerDownload: (download) => downloads.push(download),
    render: () => {},
    announce: (message) => announcements.push(message),
    confirmReplace: () => true,
    File: TestFile,
  });
  return { controller, announcements, documentOperations, downloads };
}

test('portable project service round-trips exact PDF bytes with workspace revision and audit', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'platen-aec-claim-service-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const workspace = new WorkspaceStateStore(store);
  const service = new ProjectBundleService(store, workspace);
  const pdf = makeTextPdf('AEC SERVICE CLAIM');
  const original = await store.createDocument({ stream: Readable.from([pdf]), displayName: 'source.pdf' });

  workspace.createEntity(original.id, 'measurements', { id: 'm-1', kind: 'measurement', quantity: 2.2 });
  workspace.appendAuditEvent(original.id, { kind: 'aec', action: 'seed' });
  const originalWorkspace = workspace.snapshot(original.id);

  const exported = await service.exportPortableBundle(original.id);
  assert.equal(exported.manifest.workspace.revision, originalWorkspace.revision);
  assert.deepEqual(exported.manifest.workspace.namespaces, originalWorkspace.namespaces);
  assert.deepEqual(exported.manifest.workspace.audit, originalWorkspace.audit);
  const bytes = Buffer.concat([exported.prefix, readFileSync(exported.sourcePath)]);
  const imported = await service.importPortableBundle(Readable.from([
    bytes.subarray(0, 5),
    bytes.subarray(5),
  ]));

  assert.notEqual(imported.document.id, original.id);
  assert.equal(imported.document.sha256, original.sha256);
  assert.equal(imported.sourceDigest, original.sha256);
  assert.deepEqual(readFileSync(store.getSourcePath(imported.document.id)), pdf);
  assert.equal(imported.workspace.revision, 1);
  assert.deepEqual(imported.workspace.namespaces, originalWorkspace.namespaces);
  assert.deepEqual(imported.workspace.audit.slice(0, -1), originalWorkspace.audit);
  assert.equal(imported.workspace.audit.at(-1).action, 'replace');
});

test('portable project service rejects framing/source-mismatch attacks and cleans temporary imports', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'platen-aec-claim-framing-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const workspace = new WorkspaceStateStore(store);
  const service = new ProjectBundleService(store, workspace);
  const pdf = makeTextPdf('AEC SERVICE FRAME');
  const original = await store.createDocument({ stream: Readable.from([pdf]), displayName: 'source.pdf' });
  const exported = await service.exportPortableBundle(original.id);
  const valid = Buffer.concat([exported.prefix, readFileSync(exported.sourcePath)]);

  const badMagic = Buffer.from(valid);
  badMagic[0] ^= 0xff;
  await assert.rejects(service.importPortableBundle(Readable.from([badMagic])), { code: 'PORTABLE_PROJECT_INVALID_MAGIC' });
  await assert.rejects(service.importPortableBundle(Readable.from([valid.subarray(0, -1)])), { code: 'PORTABLE_PROJECT_TRUNCATED' });
  await assert.rejects(service.importPortableBundle(Readable.from([valid, Buffer.from('x')])), { code: 'PORTABLE_PROJECT_TRAILING_DATA' });

  const tamperedSource = Buffer.from(valid);
  tamperedSource[tamperedSource.length - 1] ^= 1;
  const createDocument = store.createDocument.bind(store);
  let rejectedDocumentId = null;
  store.createDocument = async (...args) => {
    const doc = await createDocument(...args);
    rejectedDocumentId = doc.id;
    return doc;
  };
  try {
    await assert.rejects(service.importPortableBundle(Readable.from([tamperedSource])), { code: 'PORTABLE_PROJECT_SOURCE_MISMATCH', status: 409 });
  } finally {
    store.createDocument = createDocument;
  }
  assert.ok(rejectedDocumentId);
  assert.throws(() => store.getDocument(rejectedDocumentId), { code: 'DOCUMENT_NOT_FOUND', status: 404 });
});

test('authenticated browser routes export and import project bundles with exact local data', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const pdf = makeTextPdf('PORTABLE ROUTER AEC');
  const source = await store.createDocument({ stream: Readable.from([pdf]), displayName: 'source-aec.pdf' });
  const target = await store.createDocument({ stream: Readable.from([pdf]), displayName: 'target-aec.pdf' });
  workspaceState.createEntity(source.id, 'measurements', { id: 'm-1', kind: 'measurement', quantity: 11 });
  const token = { 'x-platen-token': 'test-session-token', origin: 'http://127.0.0.1:4173' };

  const noAuth = await invoke(handler, { url: `/api/documents/${source.id}/project-bundle` });
  assert.equal(noAuth.statusCode, 401);

  const exported = await invoke(handler, {
    url: `/api/documents/${source.id}/project-bundle`,
    headers: { 'x-platen-token': 'test-session-token' },
  });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.headers['Content-Type'].split(';', 1)[0], PROJECT_BUNDLE_MEDIA_TYPE);
  assert.equal(exported.body.toString('utf8').includes(source.id), false);

  const imported = await invoke(handler, {
    method: 'POST',
    url: `/api/documents/${target.id}/project-bundle?expectedRevision=0`,
    headers: { ...token, 'content-type': PROJECT_BUNDLE_MEDIA_TYPE },
    body: exported.body,
  });
  assert.equal(imported.statusCode, 200);
  const result = JSON.parse(imported.body);
  assert.equal(result.workspace.documentId, target.id);
  assert.equal(result.workspace.revision, 1);
  assert.equal(result.workspace.namespaces.measurements[0].kind, 'measurement');

  const portableExport = await invoke(handler, { url: `/api/documents/${source.id}/portable-project-bundle`, headers: { 'x-platen-token': 'test-session-token' } });
  assert.equal(portableExport.statusCode, 200);
  assert.equal(portableExport.headers['Content-Type'], PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE);
  assert.equal(portableExport.body.length, Number(portableExport.headers['Content-Length']));

  const portableImport = await invoke(handler, {
    method: 'POST',
    url: '/api/project-bundles',
    headers: { ...token, 'content-type': PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE },
    body: [portableExport.body.subarray(0, 11), portableExport.body.subarray(11)],
  });
  assert.equal(portableImport.statusCode, 201);
  const portableResult = JSON.parse(portableImport.body).result;
  assert.notEqual(portableResult.document.id, source.id);
  assert.equal(portableResult.document.sha256, source.sha256);
  assert.deepEqual(readFileSync(store.getSourcePath(portableResult.document.id)), pdf);
  assert.equal(portableResult.workspace.namespaces.measurements[0].quantity, 11);
});

test('portable project controllers suppress stale export and cancelled import completion', async () => {
  const staleState = makeControllerState();
  const staleOperation = { documentId: 'document-1', controller: new AbortController() };
  const stale = buildController({
    state: staleState,
    operation: staleOperation,
    operationIsCurrent: () => false,
    client: {
      exportPortableProjectBundle: async () => new Blob(['project']),
      workspace: async () => ({ revision: 4, namespaces: {}, audit: [] }),
    },
  });
  await stale.controller.exportProjectBundle();
  assert.equal(staleState.domainRevision, 3);
  assert.equal(staleState.domainResult, null);
  assert.equal(staleState.domainError, null);
  assert.equal(staleState.domainBusy, false);
  assert.equal(stale.announcements.length, 0);
  assert.equal(stale.downloads.length, 0);

  const cancelledState = makeControllerState();
  const cancelledOperation = { documentId: 'document-1', controller: new AbortController() };
  const cancelled = buildController({
    state: cancelledState,
    operation: cancelledOperation,
    operationIsCurrent: (operation) => operation === cancelledOperation,
    client: {
      importPortableProjectBundle: async () => {
        cancelled.documentOperations.activeController.abort();
        throw new Error('cancelled');
      },
    },
  });
  await cancelled.controller.importProjectBundle(new TestFile(
    ['portable project'],
    'project.platen-project',
    { type: PORTABLE_PROJECT_BUNDLE_MEDIA_TYPE },
  ));
  assert.equal(cancelledState.domainRevision, 3);
  assert.equal(cancelledState.domainResult, null);
  assert.equal(cancelledState.domainError, 'Portable project import was cancelled.');
  assert.equal(cancelledState.domainBusy, false);
  assert.equal(cancelledState.canCancel, false);
  assert.equal(cancelled.announcements.length, 0);
});
