import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageCompositionController } from '../src/controllers/page-composition-controller.js';

function fixture() {
  const calls = [];
  const downloads = [];
  const errors = [];
  const announcements = [];
  const picker = { value: 'selected' };
  const state = {
    analysis: { status: 'ready', documentId: 'primary', inspection: { pageCount: 3 }, sha256: 'a'.repeat(64) },
    host: {
      status: 'ready', conversionReady: true, pdfkitOutlineSplitReady: true,
      engines: [{ name: 'magick', available: true }],
    },
    selectedPage: 2,
    pageOrder: [1, 2, 3],
    splitRulePages: '2',
    copySourcePage: '4',
    busyAction: null,
    error: null,
  };
  const operation = { documentId: 'primary', controller: new AbortController() };
  let activeController = operation.controller;
  const client = {
    async arrangePages(documentId, pages) {
      calls.push(['arrange', documentId, pages]);
      return { id: 'arranged', displayName: 'arranged.pdf' };
    },
    async artifact(id) { calls.push(['artifact', id]); return new Blob(['pdf']); },
    async upload(file) { calls.push(['upload', file.name]); return { id: 'secondary', sha256: 'b'.repeat(64) }; },
    async mergeDocuments(primary, secondary) {
      calls.push(['merge', primary, secondary]);
      return { id: 'merged', displayName: 'merged.pdf' };
    },
    async copyPageBetweenDocuments(primary, secondary, request) {
      calls.push(['copy-page', primary, secondary, request]);
      return { id: 'copied-page', displayName: 'copied-page.pdf' };
    },
    async uploadInput(file) {
      calls.push(['upload-input', file.name]);
      return { id: 'scan-input', sha256: 'c'.repeat(64) };
    },
    async convertInput(inputId) {
      calls.push(['convert-input', inputId]);
      return {
        id: 'scan-output',
        sha256: 'd'.repeat(64),
        operation: { validation: { pageCount: 1 } },
      };
    },
    async deleteInput(inputId) {
      calls.push(['delete-input', inputId]);
    },
  };
  const controller = createPageCompositionController({
    state,
    client,
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    reportOperationError: (error) => errors.push(error.message),
    finishOperation: () => { state.busyAction = null; activeController = null; },
    getActiveController: () => activeController,
    removeHostDocument: async (id) => calls.push(['remove', id]),
    downloadDerivedArtifact: async (artifact, _operation, message) => {
      downloads.push({ artifact, message });
      return true;
    },
    triggerDownload: (download) => downloads.push(download),
    selectPage: (page) => { state.selectedPage = page; return true; },
    setSelectedPageIdentity: (page) => { state.selectedPage = page; return true; },
    render: () => {},
    announce: (message) => announcements.push(message),
    showError: (error) => errors.push(error.message),
    document: { querySelector: () => picker },
  });
  return {
    state, calls, downloads, errors, announcements, picker, controller,
    resetActive() { activeController = operation.controller; },
  };
}

test('page composition controller owns arrangement transitions and export', async () => {
  const context = fixture();
  assert.equal(context.controller.arrangementChanged(), false);
  context.controller.moveSelectedPage(-1);
  assert.deepEqual(context.state.pageOrder, [2, 1, 3]);
  assert.equal(context.controller.arrangementChanged(), true);

  await context.controller.exportArrangement();
  assert.deepEqual(context.calls.find(([name]) => name === 'arrange'), [
    'arrange', 'primary', [2, 1, 3],
  ]);
  assert.equal(context.downloads[0].fileName, 'arranged.pdf');

  context.controller.restorePageOrder();
  assert.deepEqual(context.state.pageOrder, [1, 2, 3]);
  context.state.pageOrder = [2];
  context.controller.removeSelectedPage();
  assert.deepEqual(context.errors, ['A derived PDF must contain at least one page.']);
});

test('page composition stages, exports, and cleans the exact secondary document', async () => {
  const context = fixture();
  await context.controller.runSecondaryComposition({ name: 'secondary.pdf' }, 'merge');
  assert.deepEqual(context.calls.filter(([name]) => ['upload', 'merge', 'remove'].includes(name)), [
    ['upload', 'secondary.pdf'],
    ['merge', 'primary', 'secondary'],
    ['remove', 'secondary'],
  ]);
  assert.equal(context.downloads[0].artifact.id, 'merged');
  assert.equal(context.picker.value, '');

  context.state.splitRulePages = '0';
  context.resetActive();
  await context.controller.splitDocumentByRule();
  assert.match(context.errors.at(-1), /integer from 1 through 500/u);
});

test('scan append uploads, converts, appends one page, and cleans temporary scan artifacts', async () => {
  const context = fixture();
  await context.controller.appendScannedPage({ name: 'scan.jpg' });
  assert.deepEqual(context.calls.slice(0, 3), [
    ['upload-input', 'scan.jpg'],
    ['convert-input', 'scan-input'],
    ['copy-page', 'primary', 'scan-output', {
      primarySourceSha256: 'a'.repeat(64),
      secondarySourceSha256: 'd'.repeat(64),
      sourcePage: 1,
      afterPage: 2,
    }],
  ]);
  assert.deepEqual(context.calls.find(([name]) => name === 'delete-input'), ['delete-input', 'scan-input']);
  assert.deepEqual(
    context.calls.find((call) => call[0] === 'remove' && call[1] === 'scan-output'),
    ['remove', 'scan-output'],
  );
  assert.equal(context.downloads[0].artifact.id, 'copied-page');
  assert.equal(context.picker.value, '');
});

test('page composition snapshots both source bindings and exact page positions before upload', async () => {
  const context = fixture();
  const promise = context.controller.runSecondaryComposition(
    { name: 'secondary.pdf' },
    'copy-page',
  );
  context.state.analysis.sha256 = 'c'.repeat(64);
  context.state.selectedPage = 1;
  context.state.copySourcePage = '9';
  await promise;
  assert.deepEqual(context.calls.find(([name]) => name === 'copy-page'), [
    'copy-page',
    'primary',
    'secondary',
    {
      primarySourceSha256: 'a'.repeat(64),
      secondarySourceSha256: 'b'.repeat(64),
      sourcePage: 4,
      afterPage: 2,
    },
  ]);
  assert.equal(context.downloads[0].artifact.id, 'copied-page');
  assert.equal(context.picker.value, '');
});
