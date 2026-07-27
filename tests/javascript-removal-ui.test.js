import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitWorkflowController } from '../src/controllers/pdfkit-workflow-controller.js';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';
import { editorView } from '../src/ui/editor-view.js';
import { state as viewState } from './support/view-render-fixture.js';

function analysis(javascript = 'yes') {
  return {
    status: 'ready', documentId: '11111111-1111-4111-8111-111111111111',
    sha256: 'a'.repeat(64),
    inspection: { pageCount: 1, encrypted: 'no', form: 'none', javascript, tagged: 'no' },
    structure: { xmpMetadata: { present: false }, urls: [], pageBoxes: [] },
    attachments: [], signatures: { status: 'unsigned', signatureCount: 0 },
    textPages: [], thumbnails: [], fonts: [], images: [],
  };
}

function state(javascript = 'yes') {
  return viewState({
    document: { isOpen: true, name: 'scripted.pdf', size: 4_096, type: 'application/pdf', objectUrl: 'blob:scripted', modified: false },
    host: { status: 'ready', javascriptRemovalReady: true, engines: [] },
    analysis: analysis(javascript),
  });
}

test('JavaScript-removal controller runs one fixed source-bound artifact operation', async () => {
  const current = state(); const calls = []; const confirmations = [];
  const operation = { documentId: current.analysis.documentId, controller: new AbortController() };
  const controller = createPdfKitWorkflowController({
    state: current,
    client: { async runJavaScriptRemoval(...args) {
      calls.push(args); return { kind: 'pdf-javascript-removal', artifact: { displayName: 'clean.pdf' } };
    } },
    captureOperation: () => operation, operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; },
    finishOperation: () => { current.busyAction = null; }, render() {}, announce() {},
    showError: (error) => { throw error; }, downloadDerivedArtifact: async () => true,
    downloadEphemeralDerivedArtifact: async () => true,
    confirm: (message) => { confirmations.push(message); return true; },
  });
  await controller.runJavaScriptRemoval();
  assert.equal(calls[0][0], current.analysis.documentId);
  assert.equal(calls[0][1], current.analysis.sha256);
  assert(calls[0][2].signal instanceof AbortSignal);
  assert.match(confirmations[0], /not general hidden-data sanitization/i);
  assert.equal(current.javascriptRemovalResult?.kind, 'pdf-javascript-removal');
});

test('JavaScript-removal UI treats positive public evidence as a candidate and states its limits', () => {
  const eligible = state();
  assert.equal(deriveEditorReadiness(eligible, eligible.analysis).javascriptRemovalReady, true);
  const html = editorView(eligible);
  assert.match(html, /data-action="remove-document-javascript" >Create JavaScript-removed copy/);
  assert.match(html, /fresh closed classic revision/);
  assert.match(html, /coarse candidate check/i);
  assert.match(html, /may reject it/i);
  assert.match(html, /not general hidden-data sanitization/i);

  const passive = state('no');
  assert.equal(deriveEditorReadiness(passive, passive.analysis).javascriptRemovalReady, false);
  assert.match(editorView(passive), /data-action="remove-document-javascript" disabled/);
  const signed = state(); signed.analysis.signatures = { status: 'signed', signatureCount: 1 };
  assert.equal(deriveEditorReadiness(signed, signed.analysis).javascriptRemovalReady, false);
});
