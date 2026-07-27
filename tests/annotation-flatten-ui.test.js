import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitWorkflowController } from '../src/controllers/pdfkit-workflow-controller.js';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';
import { editorView } from '../src/ui/editor-view.js';
import { state as viewState } from './support/view-render-fixture.js';

const sourceSha256 = 'a'.repeat(64); const fingerprint = 'b'.repeat(64);
function state() {
  return viewState({
    document: { isOpen: true, name: 'square.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:square', modified: false },
    host: { status: 'ready', annotationFlattenReady: true, pdfkitInspectionReady: true, engines: [] },
    selectedPage: 1, pdfkitExistingAnnotationIndex: '0',
    analysis: {
      status: 'ready', documentId: '11111111-1111-4111-8111-111111111111', sha256: sourceSha256,
      inspection: { pageCount: 1, encrypted: 'no', form: 'none', javascript: 'no', tagged: 'no' },
      structure: { xmpMetadata: { present: false }, urls: [], pageBoxes: [] }, attachments: [],
      signatures: { status: 'unsigned', signatureCount: 0 }, textPages: [], thumbnails: [], fonts: [], images: [],
    },
    pdfkitInspectionResult: {
      kind: 'pdfkit-structure-inspection', sourceDigest: sourceSha256, pageCount: 1,
      pages: [{ index: 1, rotation: 0, annotationsTruncated: false, annotations: [{ page: 1, annotationIndex: 0, fingerprint, subtype: 'square' }], widgets: [], links: [] }],
      optionalContent: { present: false, groupCount: 0, groups: [] },
      outline: { items: [], truncated: false }, pageLabels: { present: false, items: [], truncated: false },
    },
  });
}

test('annotation-flatten UI gates the sole inspected square annotation', () => {
  const eligible = state();
  assert.equal(deriveEditorReadiness(eligible, eligible.analysis).annotationFlattenReady, true);
  const html = editorView(eligible);
  assert.match(html, /data-action="flatten-pdfkit-annotation" >Create flattened copy/);
  assert.match(html, /sole annotation in the document/i);
  assert.match(html, /closed rewrite without the annotation object or prior revisions/i);
  const multiple = state(); multiple.pdfkitInspectionResult.pages[0].annotations.push({ annotationIndex: 1, fingerprint: 'c'.repeat(64), subtype: 'square' });
  assert.equal(deriveEditorReadiness(multiple, multiple.analysis).annotationFlattenReady, false);
  const rotated = state(); rotated.pdfkitInspectionResult.pages[0].rotation = 90;
  assert.equal(deriveEditorReadiness(rotated, rotated.analysis).annotationFlattenReady, false);
  const signed = state(); signed.analysis.signatures = { status: 'signed', signatureCount: 1 };
  assert.equal(deriveEditorReadiness(signed, signed.analysis).annotationFlattenReady, false);
});

test('annotation-flatten controller snapshots and sends one exact locator', async () => {
  const current = state(); const calls = []; const confirmations = [];
  const operation = { documentId: current.analysis.documentId, controller: new AbortController() };
  const controller = createPdfKitWorkflowController({
    state: current,
    client: { async runAnnotationFlatten(...args) { calls.push(args); return { kind: 'pdf-square-annotation-flatten', artifact: { displayName: 'flat.pdf' } }; } },
    captureOperation: () => operation, operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; }, finishOperation: () => { current.busyAction = null; },
    render() {}, announce() {}, showError: (error) => { throw error; },
    downloadDerivedArtifact: async () => true, downloadEphemeralDerivedArtifact: async () => true,
    confirm: (message) => { confirmations.push(message); return true; },
  });
  await controller.runAnnotationFlatten();
  assert.equal(calls[0][0], current.analysis.documentId);
  assert.equal(calls[0][1], sourceSha256);
  assert.deepEqual(calls[0][2], { target: { page: 1, annotationIndex: 0, fingerprint, subtype: 'square' } });
  assert(calls[0][3].signal instanceof AbortSignal);
  assert.match(confirmations[0], /removes the annotation object and prior revisions/i);
  assert.equal(current.annotationFlattenResult?.kind, 'pdf-square-annotation-flatten');
});
