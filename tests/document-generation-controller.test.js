import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocumentGenerationController } from '../src/controllers/document-generation-controller.js';

class TestFile extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = name;
  }
}

function fixture() {
  const calls = [];
  const opened = [];
  const errors = [];
  const removed = [];
  const state = {
    busyAction: null,
    error: null,
    blankPageCount: '2',
    creationTitle: 'Local draft',
    creationText: 'Body',
    analysis: { documentId: 'source-1' },
  };
  const operation = { documentId: 'source-1', controller: new AbortController() };
  const controller = createDocumentGenerationController({
    state,
    client: {
      async createBlank(body) {
        calls.push(['createBlank', body]);
        return { id: 'derived-1', displayName: 'blank.pdf' };
      },
      async createText(body) {
        calls.push(['createText', body]);
        return { id: 'derived-2', displayName: 'text.pdf' };
      },
      async documentSource(id) {
        calls.push(['source', id]);
        return new Blob(['pdf'], { type: 'application/pdf' });
      },
    },
    connectLocalHost: async () => {},
    openFile: async (file) => opened.push(file),
    removeHostDocument: async (id) => removed.push(id),
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    reportOperationError: (error) => errors.push(error.message),
    finishOperation: () => { state.busyAction = null; },
    triggerDownload: () => {},
    render: () => {},
    announce: () => {},
    showError: (error) => errors.push(error.message),
    document: { querySelector: () => null },
    navigator: { clipboard: { readText: async () => 'Clipboard body' } },
    File: TestFile,
  });
  return { state, controller, calls, opened, removed, errors };
}

test('document generation validates and reopens locally derived PDFs', async () => {
  const context = fixture();
  await context.controller.createLocalDocument('blank');
  assert.deepEqual(context.calls[0], ['createBlank', { pages: 2, title: 'Local draft' }]);
  assert.equal(context.opened[0].name, 'blank.pdf');
  assert.deepEqual(context.removed, ['derived-1']);

  context.state.blankPageCount = '0';
  await context.controller.createLocalDocument('blank');
  assert.match(context.errors.at(-1), /integer from 1 through 500/u);
});

test('document generation reads bounded clipboard text through the same text pipeline', async () => {
  const context = fixture();
  await context.controller.createFromClipboard();
  assert.equal(context.state.creationText, 'Clipboard body');
  assert.deepEqual(context.calls[0], [
    'createText',
    { text: 'Clipboard body', title: 'Local draft' },
  ]);
  assert.equal(context.opened[0].name, 'text.pdf');
});
