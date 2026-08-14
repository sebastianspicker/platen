import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocumentLifecycleController } from '../src/controllers/document-lifecycle-controller.js';
import { createAppState } from '../src/core/app-state.js';

function fixture() {
  const events = [];
  const deleted = [];
  const state = createAppState({
    documentSnapshot: Object.freeze({ isOpen: false, name: null }),
    snapshotClipboardReady: false,
  });
  const session = {
    async open(file, { shouldCommit }) {
      assert.equal(shouldCommit(), true);
      this.snapshot = Object.freeze({ isOpen: true, name: file.name, size: file.size });
      events.push('session-open');
      return this.snapshot;
    },
    close() {
      this.snapshot = Object.freeze({ isOpen: false, name: null });
      events.push('session-close');
      return this.snapshot;
    },
    dispose() { events.push('session-dispose'); },
  };
  const client = {
    connected: true,
    async bootstrap() {
      events.push('bootstrap');
      return {
        host: { workflowDomainsReady: true },
        engines: [{ name: 'tesseract', available: true }],
      };
    },
    async domainOperations() { return [{ group: 'review', operation: 'createAnnotation' }]; },
    async ocrLanguages() { return ['deu']; },
    async upload() { events.push('upload'); return { id: 'document-1', sha256: 'a'.repeat(64) }; },
    async inspect() {
      return {
        pageCount: 2, title: 'Current title', author: 'Local author',
        subject: null, keywords: 'PDF',
      };
    },
    async text() { return [{ page: 1, text: 'Local page' }]; },
    async fonts() { return [{ name: 'Helvetica' }]; },
    async images() { return [{ page: 1 }]; },
    async attachments() { return []; },
    async signatures() { return { status: 'unsigned', signatures: [] }; },
    async inspectStructure() { return { pages: [] }; },
    async workspace() { return { revision: 7, calibrations: [], measurements: [] }; },
    async thumbnail(_documentId, page) { return new Blob([String(page)], { type: 'image/png' }); },
    async deleteDocument(documentId, options) {
      deleted.push({ documentId, options });
      return true;
    },
  };
  let operations = { activeController: new AbortController() };
  const announcements = [];
  const controller = createDocumentLifecycleController({
    state,
    session,
    client,
    getDocumentOperations: () => operations,
    render: () => events.push('render'),
    announce: (message) => announcements.push(message),
    showError: (error) => { state.error = error.message; },
    revokeThumbnails: () => events.push('revoke-thumbnails'),
    resetControlledRaster: (reason) => events.push(`controlled:${reason}`),
    resetLoupe: (reason) => events.push(`loupe:${reason}`),
    clearOcrLayoutSelection: () => {
      state.ocrLayoutResult = null;
      state.selectedOcrRecordIndex = null;
      state.selectedOcrTableCandidate = null;
    },
    syncAecRecordIds: () => events.push('sync-aec'),
    syncRedactionPlans: () => events.push('sync-redactions'),
    updateSearchResults: () => { state.searchResults = ['updated']; },
    urlApi: { createObjectURL: (blob) => `blob:${blob.size}` },
  });
  return {
    state,
    session,
    client,
    controller,
    events,
    deleted,
    announcements,
    get operations() { return operations; },
    set operations(value) { operations = value; },
  };
}

test('document lifecycle owns host bootstrap, source analysis, reset, and private cleanup', async () => {
  const context = fixture();
  const previousOperation = context.operations.activeController;
  context.state.ocrUserDictionary = 'alpha\nbeta';
  context.state.ocrLanguage = 'deu';
  context.state.ocrCleanupPreset = 'none';
  context.state.ocrSegmentation = 'line';
  context.state.ocrDetectTables = false;
  await context.controller.openFile({ name: 'local.pdf', size: 42 });

  assert.equal(previousOperation.signal.aborted, true);
  assert.equal(context.operations.activeController, null);
  assert.equal(context.controller.generation, 1);
  assert.equal(context.state.host.status, 'ready');
  assert.deepEqual(context.state.ocrLanguages, ['deu']);
  assert.equal(context.state.ocrLanguage, 'deu');
  assert.equal(context.state.ocrUserDictionary, '');
  assert.equal(context.state.ocrCleanupPreset, 'none');
  assert.equal(context.state.ocrSegmentation, 'line');
  assert.equal(context.state.ocrDetectTables, false);
  assert.equal(context.state.analysis.status, 'ready');
  assert.equal(context.state.analysis.documentId, 'document-1');
  assert.deepEqual(context.state.pdfkitMetadata, {
    title: 'Current title', author: 'Local author', subject: '', keywords: 'PDF',
  });
  assert.deepEqual(context.state.pageOrder, [1, 2]);
  assert.deepEqual(context.state.searchResults, ['updated']);
  assert.deepEqual(context.state.analysis.thumbnails, [
    { page: 1, url: 'blob:1' },
    { page: 2, url: 'blob:1' },
  ]);
  assert.equal(context.state.domainRevision, 7);
  assert.ok(context.events.includes('sync-redactions'));
  assert.equal(context.events.filter((event) => event === 'bootstrap').length, 1);
  assert.match(context.announcements.at(-1), /2 pages ready/u);

  await context.controller.closeFile();
  assert.equal(context.controller.generation, 2);
  assert.equal(context.state.document.isOpen, false);
  assert.equal(context.state.analysis.status, 'idle');
  assert.equal(context.state.analysis.documentId, null);
  assert.equal(context.state.selectedPage, 1);
  assert.equal(context.state.pdfkitInspectionResult, null);
  assert.deepEqual(context.deleted, [{ documentId: 'document-1', options: undefined }]);
  assert.equal(context.state.ocrUserDictionary, '');
  assert.equal(context.state.ocrLanguage, 'deu');
  assert.equal(context.state.ocrCleanupPreset, 'none');
  assert.equal(context.state.ocrSegmentation, 'line');
  assert.equal(context.state.ocrDetectTables, false);
  assert.equal(context.announcements.at(-1), 'Local PDF closed and private session data scheduled for deletion.');
});

test('document lifecycle deduplicates concurrent bootstrap and owns unload cancellation', async () => {
  const context = fixture();
  const [first, second] = await Promise.all([
    context.controller.connectLocalHost(),
    context.controller.connectLocalHost(),
  ]);
  assert.equal(first.status, 'ready');
  assert.equal(second, first);
  assert.equal(context.events.filter((event) => event === 'bootstrap').length, 1);

  const active = new AbortController();
  context.operations = { activeController: active };
  context.state.analysis.documentId = 'document-main';
  context.state.ocrBatchTemporaryDocumentIds = ['document-batch'];
  context.controller.dispose();
  assert.equal(active.signal.aborted, true);
  assert.equal(context.operations.activeController, null);
  assert.ok(context.events.includes('session-dispose'));
  assert.deepEqual(context.deleted, [
    { documentId: 'document-main', options: { keepalive: true } },
    { documentId: 'document-batch', options: { keepalive: true } },
  ]);
});
