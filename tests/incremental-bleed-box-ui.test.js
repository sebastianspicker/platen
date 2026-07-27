import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitWorkflowController } from '../src/controllers/pdfkit-workflow-controller.js';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';
import { editorView } from '../src/ui/editor-view.js';
import { state as viewState } from './support/view-render-fixture.js';

function passiveAnalysis() {
  return {
    status: 'ready',
    documentId: '11111111-1111-4111-8111-111111111111',
    sha256: 'a'.repeat(64),
    inspection: { pageCount: 2, encrypted: 'no', form: 'none', javascript: 'no' },
    structure: { xmpMetadata: { present: false }, urls: [] },
    attachments: [],
    signatures: { status: 'unsigned', signatureCount: 0 },
    textPages: [], thumbnails: [], fonts: [], images: [],
  };
}

test('workflow controller sends the selected integer BleedBox through the append-only path', async () => {
  const state = {
    analysis: passiveAnalysis(),
    host: { incrementalBleedBoxReady: true },
    busyAction: null,
    selectedPage: 2,
    pdfkitPageBox: 'bleed',
    pdfkitPageBoxRect: { x: 10, y: 20, width: 580, height: 740 },
  };
  const calls = []; const confirmations = [];
  const operation = {
    documentId: state.analysis.documentId,
    controller: new AbortController(),
  };
  const controller = createPdfKitWorkflowController({
    state,
    client: {
      async runIncrementalBleedBox(documentId, digest, request, options) {
        calls.push({ documentId, digest, request, options });
        return {
          kind: 'pdf-incremental-bleed-box',
          artifact: { displayName: 'source-bleed-box.pdf' },
          pageBox: { page: 2 },
        };
      },
    },
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; },
    finishOperation: () => { state.busyAction = null; },
    render() {}, announce() {},
    showError: (error) => { throw error; },
    downloadDerivedArtifact: async () => true,
    downloadEphemeralDerivedArtifact: async () => true,
    confirm: (message) => { confirmations.push(message); return true; },
  });
  await controller.runIncrementalBleedBox();
  assert.deepEqual(calls[0].request, {
    page: 2, rect: { x: 10, y: 20, width: 580, height: 740 },
  });
  assert.equal(calls[0].digest, state.analysis.sha256);
  assert(calls[0].options.signal instanceof AbortSignal);
  assert.match(confirmations[0], /same selected page object/);
  assert.equal(state.incrementalBleedBoxResult?.kind, 'pdf-incremental-bleed-box');
});

function localOnlyState(overrides = {}) {
  return viewState({
    document: {
      isOpen: true, name: 'local.pdf', size: 4096, type: 'application/pdf',
      objectUrl: 'blob:local', modified: false,
    },
    host: {
      status: 'ready', incrementalBleedBoxReady: true,
      pdfkitInspectionReady: false, pdfkitMutationReady: false, engines: [],
    },
    analysis: passiveAnalysis(),
    selectedPage: 2,
    pdfkitPageBox: 'bleed',
    pdfkitPageBoxRect: { x: 10, y: 20, width: 580, height: 740 },
    ...overrides,
  });
}

test('cross-platform BleedBox UI works without PDFKit and labels its proof limits', () => {
  const current = localOnlyState();
  const readiness = deriveEditorReadiness(current, current.analysis);
  assert.equal(readiness.incrementalBleedBoxReady, true);
  assert.equal(readiness.pdfkitPageBoxEditorReady, true);
  const html = editorView(current);
  assert.match(html, /data-action="create-incremental-bleed-box-copy" >Create object-preserving BleedBox PDF/);
  assert.match(html, /data-action="create-pdfkit-pagebox-copy" disabled>Create PDFKit BleedBox fallback/);
  assert.match(html, /same page object/);
  assert.match(html, /256-pixel-long-edge validation renders/);
  assert.match(html, /equality at other resolutions or in other renderers is not claimed/);

  const fractional = localOnlyState({
    pdfkitPageBoxRect: { x: 10.5, y: 20, width: 580, height: 740 },
  });
  assert.equal(deriveEditorReadiness(fractional, fractional.analysis).incrementalBleedBoxReady, false);
  const signed = localOnlyState({
    analysis: { ...passiveAnalysis(), signatures: { status: 'signed', signatureCount: 1 } },
  });
  assert.equal(deriveEditorReadiness(signed, signed.analysis).incrementalBleedBoxReady, false);
});
