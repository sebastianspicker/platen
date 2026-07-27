import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewerController } from '../src/controllers/viewer-controller.js';
import { createAppState } from '../src/core/app-state.js';

function fixture() {
  const announcements = [];
  const renders = [];
  const revoked = [];
  const clipboardWrites = [];
  const state = createAppState({
    documentSnapshot: { isOpen: true, name: 'drawing.pdf' },
    snapshotClipboardReady: false,
  });
  state.analysis = {
    ...state.analysis,
    status: 'ready',
    documentId: 'document-1',
    sha256: 'a'.repeat(64),
    inspection: { pageCount: 3 },
    textPages: [{ page: 1, text: 'alpha' }, { page: 2, text: 'beta' }],
    thumbnails: [{ page: 1, url: 'blob:one' }],
  };
  state.ocrZones = [{ id: 'zone-2', page: 2 }];
  state.pdfkitInspectionResult = {
    sourceDigest: state.analysis.sha256,
    pageCount: 3,
    pages: [{
      index: 2,
      rotation: 90,
      boxes: { crop: { x: 0, y: 0, width: 600, height: 800 } },
      widgets: [{ annotationIndex: 4, fieldType: 'text' }],
      annotationsTruncated: false,
      annotations: [
        { annotationIndex: 7, subtype: 'highlight' },
        { annotationIndex: 8, subtype: 'link', fingerprint: 'f'.repeat(64) },
      ],
      linksTruncated: false,
      links: [{ annotationIndex: 8, kind: 'goTo', targetPage: 3 }],
    }],
  };
  const controller = createViewerController({
    state,
    client: {
      async cropBoxRaster() { return new Blob(['png'], { type: 'image/png' }); },
      async cropBoxSnapshot() { return new Blob(['png'], { type: 'image/png' }); },
      async thumbnail() { return new Blob(['png'], { type: 'image/png' }); },
    },
    captureOperation: () => ({ documentId: 'document-1', controller: new AbortController() }),
    operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; },
    finishOperation: () => {},
    triggerDownload: () => {},
    clearOcrLayoutSelection: () => {
      state.ocrLayoutResult = null;
      state.selectedOcrRecordIndex = null;
      state.selectedOcrTableCandidate = null;
    },
    render: () => renders.push('render'),
    announce: (message) => announcements.push(message),
    showError: (error) => { state.error = error.message; },
    document: {
      documentElement: { lang: 'en' },
      querySelector: () => ({ focus() {} }),
    },
    window: { Image: class {} },
    navigator: { clipboard: { writeText: async (text) => clipboardWrites.push(text) } },
    urlApi: {
      createObjectURL: () => 'blob:generated',
      revokeObjectURL: (url) => revoked.push(url),
    },
  });
  return {
    state, controller, announcements, renders, revoked, clipboardWrites,
  };
}

test('viewer controller owns page identity, navigation history, and PDFKit selection defaults', () => {
  const context = fixture();
  assert.equal(context.controller.selectPage(2), true);
  assert.equal(context.state.selectedPage, 2);
  assert.deepEqual(context.state.navigationHistory, [1, 2]);
  assert.equal(context.state.selectedOcrZoneId, 'zone-2');
  assert.equal(context.state.pdfkitWidgetIndex, '4');
  assert.equal(context.state.pdfkitExistingAnnotationIndex, '7');
  assert.equal(context.state.pdfkitLocalLinkRemovalIndex, '8');
  assert.equal(context.state.pdfkitPageRotation, '180');

  context.controller.navigateHistory(-1);
  assert.equal(context.state.selectedPage, 1);
  assert.equal(context.state.navigationIndex, 0);
  assert.match(context.announcements.at(-1), /Page 1 selected/u);
});

test('viewer controller owns search, view transitions, and raster URL cleanup', () => {
  const context = fixture();
  context.state.searchQuery = 'beta';
  context.controller.updateSearchResults();
  assert.deepEqual(context.state.searchResults.map(({ page }) => page), [2]);

  context.controller.setView('workflows');
  assert.equal(context.state.view, 'workflows');
  context.controller.revokeThumbnails();
  assert.deepEqual(context.revoked, ['blob:one']);
  assert.ok(context.renders.length >= 1);
});

test('viewer controller copies only the current page text after clipboard resolution', async () => {
  const context = fixture();
  await context.controller.copySelectedPageText();
  assert.deepEqual(context.clipboardWrites, ['alpha']);
  assert.match(context.announcements.at(-1), /Text from page 1 copied/u);
  context.state.analysis.documentId = null;
  await context.controller.copySelectedPageText();
  assert.deepEqual(context.clipboardWrites, ['alpha']);
});

test('viewer controller suppresses stale page-text clipboard completion announcements', async () => {
  const context = fixture();
  let resolveWrite;
  context.controller = createViewerController({
    state: context.state,
    client: {
      async cropBoxRaster() { return new Blob(['png'], { type: 'image/png' }); },
      async cropBoxSnapshot() { return new Blob(['png'], { type: 'image/png' }); },
      async thumbnail() { return new Blob(['png'], { type: 'image/png' }); },
    },
    captureOperation: () => ({ documentId: 'document-1', controller: new AbortController() }),
    operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; }, finishOperation: () => {}, triggerDownload: () => {},
    clearOcrLayoutSelection: () => {}, render: () => {}, announce: (message) => context.announcements.push(message),
    showError: (error) => { context.state.error = error.message; }, document: { documentElement: { lang: 'en' } },
    window: { Image: class {} }, navigator: { clipboard: { writeText: () => new Promise((resolve) => { resolveWrite = resolve; }) } },
    urlApi: { createObjectURL: () => 'blob:generated', revokeObjectURL: () => {} },
  });
  const copy = context.controller.copySelectedPageText();
  context.controller.selectPage(2);
  resolveWrite();
  await copy;
  assert.doesNotMatch(context.announcements.join('\n'), /Text from page 1 copied/u);
});
