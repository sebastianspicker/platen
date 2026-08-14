import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import { createOcrWorkflowController } from '../src/controllers/ocr-workflow-controller.js';
import { createAppState } from '../src/core/app-state.js';

function screenshotFixture() {
  const state = createAppState({
    documentSnapshot: { isOpen: true, name: 'r06-source.pdf', size: 12, type: 'application/pdf' },
  });
  state.analysis.documentId = 'source-document';
  state.analysis.sha256 = 'a'.repeat(64);
  state.ocrLanguages = ['eng'];
  state.ocrLanguage = 'eng';
  const image = new Blob(['PNG screenshot bytes'], { type: 'image/png' });
  const output = new Blob(['%PDF-1.7\nR06 screenshot OCR'], { type: 'application/pdf' });
  const outputBytes = Buffer.from('%PDF-1.7\nR06 screenshot OCR');
  const artifact = {
    id: 'ocr-artifact',
    documentId: 'clipboard-document',
    size: output.size,
    sha256: createHash('sha256').update(outputBytes).digest('hex'),
    displayName: 'r06-screenshot-searchable-ocr.pdf',
  };
  const deleted = { artifacts: [], inputs: [], documents: [] };
  const calls = { upload: 0, convert: 0, ocr: 0 };
  let sourceDigest = 'b'.repeat(64);
  let deleteInputError = null;
  const navigatorApi = {
    clipboard: {
      async read() {
        return [{ types: ['image/png'], async getType() { return image; } }];
      },
    },
  };
  class FileCtor extends Blob {
    constructor(parts, name, options) { super(parts, options); this.name = name; }
  }
  const controller = createOcrWorkflowController({
    state,
    client: {
      async uploadInput(file) { calls.upload += 1; assert.equal(file.type, 'image/png'); return { id: 'clipboard-input' }; },
      async convertInput(id) { calls.convert += 1; assert.equal(id, 'clipboard-input'); return { id: 'clipboard-document', sha256: 'b'.repeat(64), operation: { validation: { pageCount: 1 } } }; },
      async ocrDocument(id, options) { calls.ocr += 1; assert.equal(id, 'clipboard-document'); assert.equal(options.language, 'eng'); return { sourceDigest, artifact, result: { language: 'eng', cleanupPreset: 'document', segmentation: 'auto', pageCount: 1, recognizedWordCount: 1, suspects: [] } }; },
      async artifact() { return output; },
      async deleteArtifact(id) { deleted.artifacts.push(id); },
      async deleteInput(id) { deleted.inputs.push(id); if (deleteInputError) throw deleteInputError; },
    },
    getDocumentOperations: () => ({ activeController: null }),
    captureOperation: () => ({ documentId: state.analysis.documentId, controller: new AbortController() }),
    operationIsCurrent: () => true,
    reportOperationError: (error) => { state.error = error.message; },
    finishOperation: () => { state.busyAction = null; },
    removeHostDocument: async (id) => { deleted.documents.push(id); },
    triggerDownload: (download) => { state.download = download; },
    render: () => {},
    announce: () => {},
    showError: (error) => { state.error = error.message; },
    cryptoApi: webcrypto,
    navigatorApi,
    FileCtor,
  });
  return { state, controller, navigatorApi, deleted, calls, artifact, setSourceDigest(value) { sourceDigest = value; }, setDeleteInputError(value) { deleteInputError = value; } };
}

test('R06 narrowed clipboard-PNG screenshot OCR binds temporary conversion and cleans all host state', async () => {
  const fixture = screenshotFixture();
  await fixture.controller.createClipboardScreenshotOcr();
  assert.equal(fixture.calls.upload, 1);
  assert.equal(fixture.calls.convert, 1);
  assert.equal(fixture.calls.ocr, 1);
  assert.equal(fixture.state.download.fileName, 'r06-source-clipboard-screenshot-searchable-ocr.pdf');
  assert.deepEqual(fixture.deleted, {
    artifacts: ['ocr-artifact'],
    inputs: ['clipboard-input'],
    documents: ['clipboard-document'],
  });
  assert.equal(fixture.state.error, null);
});

test('R06 clipboard screenshot OCR rejects non-single-PNG input, source forgery, and cleanup failure', async () => {
  const multiple = screenshotFixture();
  multiple.navigatorApi.clipboard.read = async () => [
    { types: ['image/png'], getType: async () => new Blob(['one'], { type: 'image/png' }) },
    { types: ['image/png'], getType: async () => new Blob(['two'], { type: 'image/png' }) },
  ];
  await multiple.controller.createClipboardScreenshotOcr();
  assert.match(multiple.state.error, /exactly one clipboard item/u);
  assert.equal(multiple.calls.upload, 0);

  const wrongType = screenshotFixture();
  wrongType.navigatorApi.clipboard.read = async () => [{ types: ['text/plain'], getType: async () => new Blob(['no']) }];
  await wrongType.controller.createClipboardScreenshotOcr();
  assert.match(wrongType.state.error, /exactly one PNG representation/u);
  assert.equal(wrongType.calls.upload, 0);

  const forged = screenshotFixture();
  forged.setSourceDigest('c'.repeat(64));
  await forged.controller.createClipboardScreenshotOcr();
  assert.match(forged.state.error, /not bound to the temporary conversion output/u);
  assert.equal(forged.state.download, undefined);
  assert.deepEqual(forged.deleted, { artifacts: ['ocr-artifact'], inputs: ['clipboard-input'], documents: ['clipboard-document'] });

  const cleanup = screenshotFixture();
  cleanup.setDeleteInputError(new Error('input cleanup failed'));
  await cleanup.controller.createClipboardScreenshotOcr();
  assert.match(cleanup.state.error, /input cleanup failed/u);
  assert.equal(cleanup.state.download, undefined);
  assert.deepEqual(cleanup.deleted, { artifacts: ['ocr-artifact'], inputs: ['clipboard-input'], documents: ['clipboard-document'] });
});
