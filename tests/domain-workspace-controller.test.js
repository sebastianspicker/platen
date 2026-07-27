import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainWorkspaceController } from '../src/controllers/domain-workspace-controller.js';

class TestFile extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = name;
  }
}

function fixture() {
  const downloads = [];
  const announcements = [];
  const state = {
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
  const operation = { documentId: 'document-1', controller: new AbortController() };
  const documentOperations = { activeController: null };
  const controller = createDomainWorkspaceController({
    state,
    client: {
      async executeDomain() { return { revision: 4, record: { id: 'annotation-1' } }; },
      async exportPortableProjectBundle() { return new Blob(['project']); },
      async workspace() {
        return {
          revision: 4,
          namespaces: { review: [{ id: 'annotation-1' }], forms: [] },
          audit: [{ action: 'create' }],
        };
      },
    },
    getDocumentOperations: () => documentOperations,
    connectLocalHost: async () => {},
    openFile: async () => {},
    removeHostDocument: async () => {},
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    finishOperation: () => { state.domainBusy = false; },
    syncAecRecordIds: () => {},
    triggerDownload: (download) => downloads.push(download),
    render: () => {},
    announce: (message) => announcements.push(message),
    confirmReplace: () => true,
    File: TestFile,
  });
  return { state, controller, downloads, announcements };
}

test('domain workspace controller owns selection and revision-aware execution', async () => {
  const context = fixture();
  context.controller.selectDomainOperation('review', 'createAnnotation');
  assert.deepEqual(context.state.selectedDomainOperation, {
    group: 'review', operation: 'createAnnotation',
  });
  assert.equal(JSON.parse(context.state.domainPayload).options.expectedRevision, 3);

  await context.controller.runDomainOperation();
  assert.equal(context.state.domainRevision, 4);
  assert.equal(context.state.domainResult.record.id, 'annotation-1');
  assert.match(context.announcements.at(-1), /review createAnnotation completed/u);
});

test('domain workspace controller exports a bounded digest-bound project', async () => {
  const context = fixture();
  await context.controller.exportProjectBundle();
  assert.equal(context.downloads[0].fileName, 'plan.platen-project');
  assert.equal(context.state.domainResult.kind, 'portable-project-export');
  assert.deepEqual(context.state.domainResult.populatedNamespaces, { review: 1 });
  assert.equal(context.state.domainResult.sourcePdfSha256, 'a'.repeat(64));
});
