import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitWorkflowController } from '../src/controllers/pdfkit-workflow-controller.js';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';
import { editorView } from '../src/ui/editor-view.js';
import { state as viewState } from './support/view-render-fixture.js';

function readyAnalysis() {
  return {
    status: 'ready',
    documentId: '11111111-1111-4111-8111-111111111111',
    sha256: 'a'.repeat(64),
    inspection: { pageCount: 2, encrypted: 'no', form: 'none', javascript: 'no' },
    structure: { xmpMetadata: { present: false }, urls: [] },
    attachments: [],
    signatures: { status: 'unsigned', signatureCount: 0 },
    textPages: [],
    thumbnails: [],
    fonts: [],
    images: [],
  };
}

function readyState(overrides = {}) {
  return {
    analysis: readyAnalysis(),
    host: {
      incrementalPageVectorReady: true,
      engines: [],
    },
    busyAction: null,
    selectedPage: 2,
    incrementalPageVectorRect: { x: 10, y: 20, width: 580, height: 740 },
    ...overrides,
  };
}

test('page-vector controller sends one selected-page integer rectangle', async () => {
  const state = readyState();
  const calls = [];
  const confirmations = [];
  const operation = {
    documentId: state.analysis.documentId,
    controller: new AbortController(),
  };
  const controller = createPdfKitWorkflowController({
    state,
    client: {
      async runIncrementalPageVector(documentId, digest, request, options) {
        calls.push({ documentId, digest, request, options });
        return {
          kind: 'pdf-incremental-page-vector',
          artifact: { displayName: 'page-vector.pdf' },
          vector: { page: 2 },
        };
      },
    },
    captureOperation: () => operation,
    operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; },
    finishOperation: () => { state.busyAction = null; },
    render: () => {},
    announce: () => {},
    showError: (error) => { throw error; },
    downloadDerivedArtifact: async () => true,
    downloadEphemeralDerivedArtifact: async () => true,
    confirm: (message) => {
      confirmations.push(message);
      return true;
    },
  });
  await controller.runIncrementalPageVector();
  assert.deepEqual(calls[0].request, {
    page: 2,
    rect: { x: 10, y: 20, width: 580, height: 740 },
  });
  assert.equal(calls[0].digest, state.analysis.sha256);
  assert.match(confirmations[0], /fixed-stroke vector overlay/);
  assert.equal(state.incrementalPageVectorResult?.kind, 'pdf-incremental-page-vector');
});

test('page-vector UI is available without PDFKit and rejects no-op or invalid geometry', () => {
  const withService = viewState(readyState());
  const readiness = deriveEditorReadiness(withService, withService.analysis);
  assert.equal(readiness.incrementalPageVectorReady, true);
  const html = editorView(withService);
  assert.match(html, /data-action="create-incremental-page-vector-copy" >Create object-preserving page-vector PDF/);
  assert.match(html, /one black 1pt stroked rectangle/);
  assert.match(html, /not general vector editing/);

  const fractional = viewState(readyState({ incrementalPageVectorRect: { x: 10.5, y: 20, width: 580, height: 740 } }));
  assert.equal(deriveEditorReadiness(fractional, fractional.analysis).incrementalPageVectorReady, false);

  const signed = viewState(readyState({
    analysis: {
      ...readyAnalysis(),
      signatures: { status: 'signed', signatureCount: 1 },
    },
  }));
  assert.equal(deriveEditorReadiness(signed, signed.analysis).incrementalPageVectorReady, false);
});
