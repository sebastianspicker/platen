import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitWorkflowController } from '../src/controllers/pdfkit-workflow-controller.js';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';
import { editorView } from '../src/ui/editor-view.js';
import { state as viewState } from './support/view-render-fixture.js';

function passiveAnalysis() {
  return {
    status: 'ready', documentId: '11111111-1111-4111-8111-111111111111',
    sha256: 'a'.repeat(64),
    inspection: { pageCount: 2, encrypted: 'no', form: 'none', javascript: 'no' },
    structure: {
      xmpMetadata: { present: false }, urls: [],
      pageBoxes: [1, 2].map((page) => ({
        page, boxes: { cropBox: { left: 0, bottom: 0, right: 100, top: 100 } },
      })),
    }, attachments: [],
    signatures: { status: 'unsigned', signatureCount: 0 },
    textPages: [], thumbnails: [], fonts: [], images: [],
  };
}

test('workflow controller sends one integer direct local-link request', async () => {
  const state = {
    analysis: passiveAnalysis(), host: { incrementalGoToLinkReady: true },
    busyAction: null, selectedPage: 1, pdfkitLinkTargetPage: '2',
    pdfkitLinkRect: { x: 10, y: 20, width: 70, height: 70 },
  };
  const calls = []; const confirmations = [];
  const operation = { documentId: state.analysis.documentId, controller: new AbortController() };
  const controller = createPdfKitWorkflowController({
    state,
    client: { async runIncrementalGoToLink(documentId, digest, request, options) {
      calls.push({ documentId, digest, request, options });
      return { kind: 'pdf-incremental-goto-link', artifact: { displayName: 'linked.pdf' } };
    } },
    captureOperation: () => operation, operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; },
    finishOperation: () => { state.busyAction = null; }, render() {}, announce() {},
    showError: (error) => { throw error; }, downloadDerivedArtifact: async () => true,
    downloadEphemeralDerivedArtifact: async () => true,
    confirm: (message) => { confirmations.push(message); return true; },
  });
  await controller.runIncrementalGoToLink();
  assert.deepEqual(calls[0].request, {
    sourcePage: 1, targetPage: 2,
    rect: { left: 10, bottom: 20, right: 80, top: 90 },
  });
  assert.equal(calls[0].digest, state.analysis.sha256);
  assert(calls[0].options.signal instanceof AbortSignal);
  assert.match(confirmations[0], /direct \/Dest \/Fit/);
  assert.equal(state.incrementalGoToLinkResult?.kind, 'pdf-incremental-goto-link');
});

function localState(overrides = {}) {
  return viewState({
    document: {
      isOpen: true, name: 'local.pdf', size: 4096, type: 'application/pdf',
      objectUrl: 'blob:local', modified: false,
    },
    host: {
      status: 'ready', incrementalGoToLinkReady: true,
      pdfkitInspectionReady: false, pdfkitMutationReady: false, engines: [],
    },
    analysis: passiveAnalysis(), selectedPage: 1, pdfkitLinkTargetPage: '2',
    pdfkitLinkRect: { x: 10, y: 20, width: 70, height: 70 }, ...overrides,
  });
}

test('cross-platform local-link UI works without PDFKit and states its limits', () => {
  const current = localState(); const readiness = deriveEditorReadiness(current, current.analysis);
  assert.equal(readiness.incrementalGoToLinkReady, true);
  assert.equal(readiness.pdfkitLocalLinkReady, false);
  const html = editorView(current);
  assert.match(html, /data-action="create-incremental-goto-link-copy" >Create object-preserving linked PDF/);
  assert.match(html, /data-action="create-pdfkit-local-goto-copy" disabled>Create PDFKit linked fallback/);
  assert.match(html, /direct <code>\/Dest \/Fit<\/code>/);
  assert.match(html, /exact source prefix/);
  assert.match(html, /256-pixel all-page render equality/);

  const fractional = localState({ pdfkitLinkRect: { x: 10.5, y: 20, width: 70, height: 70 } });
  assert.equal(deriveEditorReadiness(fractional, fractional.analysis).incrementalGoToLinkReady, false);
  const outside = localState({ pdfkitLinkRect: { x: 90, y: 20, width: 20, height: 20 } });
  assert.equal(deriveEditorReadiness(outside, outside.analysis).incrementalGoToLinkReady, false);
  const signed = localState({ analysis: { ...passiveAnalysis(), signatures: { status: 'signed', signatureCount: 1 } } });
  assert.equal(deriveEditorReadiness(signed, signed.analysis).incrementalGoToLinkReady, false);
});
