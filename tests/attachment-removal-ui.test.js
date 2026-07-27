import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitWorkflowController } from '../src/controllers/pdfkit-workflow-controller.js';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';
import { editorView } from '../src/ui/editor-view.js';
import { state as viewState } from './support/view-render-fixture.js';

function attachmentState() {
  return viewState({
    document: {
      isOpen: true, name: 'attached.pdf', size: 4_096,
      type: 'application/pdf', objectUrl: 'blob:attached', modified: false,
    },
    host: { status: 'ready', attachmentRemovalReady: true, engines: [] },
    analysis: {
      status: 'ready', documentId: '11111111-1111-4111-8111-111111111111',
      sha256: 'a'.repeat(64),
      inspection: {
        pageCount: 1, encrypted: 'no', form: 'none', javascript: 'no', tagged: 'no',
      },
      structure: { xmpMetadata: { present: false }, urls: [], pageBoxes: [] },
      attachments: [{ number: 1, name: 'private.txt' }],
      signatures: { status: 'unsigned', signatureCount: 0 },
      textPages: [], thumbnails: [], fonts: [], images: [],
    },
  });
}

test('attachment-removal controller runs one fixed source-bound operation', async () => {
  const current = attachmentState(); const calls = []; const confirmations = [];
  const operation = {
    documentId: current.analysis.documentId, controller: new AbortController(),
  };
  const controller = createPdfKitWorkflowController({
    state: current,
    client: { async runAttachmentRemoval(...args) {
      calls.push(args);
      return { kind: 'pdf-document-attachment-removal', artifact: { displayName: 'clean.pdf' } };
    } },
    captureOperation: () => operation, operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; },
    finishOperation: () => { current.busyAction = null; }, render() {}, announce() {},
    showError: (error) => { throw error; }, downloadDerivedArtifact: async () => true,
    downloadEphemeralDerivedArtifact: async () => true,
    confirm: (message) => { confirmations.push(message); return true; },
  });
  await controller.runAttachmentRemoval();
  assert.equal(calls[0][0], current.analysis.documentId);
  assert.equal(calls[0][1], current.analysis.sha256);
  assert(calls[0][2].signal instanceof AbortSignal);
  assert.match(confirmations[0], /not general attachment management/i);
  assert.equal(current.attachmentRemovalResult?.kind, 'pdf-document-attachment-removal');
});

test('attachment-removal UI treats one passive inventory record as a coarse candidate', () => {
  const eligible = attachmentState();
  assert.equal(deriveEditorReadiness(eligible, eligible.analysis).attachmentRemovalReady, true);
  const html = editorView(eligible);
  assert.match(html, /data-action="remove-document-attachment" >Create attachment-removed copy/);
  assert.match(html, /one exact flat document-level attachment/i);
  assert.match(html, /not attachment addition, extraction, rename, multi-attachment management/i);
  const multiple = attachmentState();
  multiple.analysis.attachments.push({ number: 2, name: 'second.txt' });
  assert.equal(deriveEditorReadiness(multiple, multiple.analysis).attachmentRemovalReady, false);
  const signed = attachmentState();
  signed.analysis.signatures = { status: 'signed', signatureCount: 1 };
  assert.equal(deriveEditorReadiness(signed, signed.analysis).attachmentRemovalReady, false);
  const unicode = attachmentState();
  unicode.analysis.attachments[0].name = 'é.txt';
  assert.equal(deriveEditorReadiness(unicode, unicode.analysis).attachmentRemovalReady, false);
});
