import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import { createDocumentGenerationController } from '../src/controllers/document-generation-controller.js';

class TestFile extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = name;
  }
}

function fixture({ clipboardItems } = {}) {
  const state = { busyAction: null, error: null, creationTitle: 'Clipboard import' };
  const events = [];
  const errors = [];
  const outputBytes = new Blob(['%PDF-clipboard%'], { type: 'application/pdf' });
  const outputSha256 = createHash('sha256').update('%PDF-clipboard%').digest('hex');
  const input = { id: 'input-1', sha256: 'a'.repeat(64) };
  const hosted = {
    id: 'document-1',
    sha256: outputSha256,
    displayName: 'clipboard-image.pdf',
    operation: {
      inputs: [{ assetId: input.id, sha256: input.sha256, role: 'source' }],
      validation: { pageCount: 1 },
    },
  };
  const operation = { controller: new AbortController() };
  const controller = createDocumentGenerationController({
    state,
    client: {
      async uploadInput(file) {
        events.push(['upload', file.type, file.name]);
        return input;
      },
      async convertInput(id) {
        events.push(['convert', id]);
        return hosted;
      },
      async documentSource(id) {
        events.push(['source', id]);
        return outputBytes;
      },
      async deleteInput(id) { events.push(['delete-input', id]); },
    },
    connectLocalHost: async () => events.push(['connect']),
    openFile: async (file) => events.push(['open', file.name]),
    removeHostDocument: async (id) => events.push(['delete-document', id]),
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    reportOperationError: (error) => errors.push(error),
    finishOperation: () => { state.busyAction = null; },
    triggerDownload: () => {},
    render: () => {},
    announce: () => {},
    showError: (error) => errors.push(error),
    document: { querySelector: () => null },
    navigator: { clipboard: { read: async () => clipboardItems ?? [] } },
    File: TestFile,
    crypto: webcrypto,
  });
  return { controller, events, errors, state };
}

test('clipboard image creation admits one PNG, binds the one-page conversion, and cleans before opening', async () => {
  const png = new Blob(['png'], { type: 'image/png' });
  const context = fixture({ clipboardItems: [{ types: ['image/png'], getType: async () => png }] });
  await context.controller.createClipboardToPdf();
  assert.deepEqual(context.events, [
    ['connect'],
    ['upload', 'image/png', 'clipboard-image.png'],
    ['convert', 'input-1'],
    ['source', 'document-1'],
    ['delete-document', 'document-1'],
    ['delete-input', 'input-1'],
    ['open', 'clipboard-image.pdf'],
  ]);
  assert.equal(context.errors.length, 0);
});

test('clipboard image creation rejects non-single PNG representations before upload', async () => {
  const context = fixture({ clipboardItems: [{ types: ['text/plain'], getType: async () => new Blob(['x']) }] });
  await context.controller.createClipboardToPdf();
  assert.equal(context.events.some(([kind]) => kind === 'upload'), false);
  assert.match(context.errors.at(-1).message, /exactly one PNG representation/u);
});

test('clipboard image creation suppresses opening when derived output digest is not bound', async () => {
  const png = new Blob(['png'], { type: 'image/png' });
  const context = fixture({ clipboardItems: [{ types: ['image/png'], getType: async () => png }] });
  context.controller = createDocumentGenerationController({
    state: context.state,
    client: {
      async uploadInput() { return { id: 'input-1', sha256: 'a'.repeat(64) }; },
      async convertInput() { return { id: 'document-1', sha256: '0'.repeat(64), displayName: 'bad.pdf', operation: { inputs: [{ assetId: 'input-1', sha256: 'a'.repeat(64) }], validation: { pageCount: 1 } } }; },
      async documentSource() { return new Blob(['not-the-recorded-digest'], { type: 'application/pdf' }); },
      async deleteInput(id) { context.events.push(['delete-input', id]); },
    },
    connectLocalHost: async () => {},
    openFile: async () => context.events.push(['open']),
    removeHostDocument: async (id) => context.events.push(['delete-document', id]),
    captureOperation: () => ({ controller: new AbortController() }),
    operationIsCurrent: () => true,
    reportOperationError: (error) => context.errors.push(error),
    finishOperation: () => { context.state.busyAction = null; },
    triggerDownload: () => {},
    render: () => {},
    announce: () => {},
    showError: (error) => context.errors.push(error),
    document: { querySelector: () => null },
    navigator: { clipboard: { read: async () => [{ types: ['image/png'], getType: async () => png }] } },
    File: TestFile,
    crypto: webcrypto,
  });
  await context.controller.createClipboardToPdf();
  assert.equal(context.events.some(([kind]) => kind === 'open'), false);
  assert.match(context.errors.at(-1).message, /digest verification/u);
  assert.deepEqual(context.events, [['delete-document', 'document-1'], ['delete-input', 'input-1']]);
});
