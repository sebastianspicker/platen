import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitWorkflowController } from '../src/controllers/pdfkit-workflow-controller.js';
import { resetDocumentState } from '../src/controllers/document-lifecycle/state-reset.js';
import { pdfKitAppState } from '../src/core/pdfkit-app-state.js';
import { createApplicationInputHandler } from '../src/ui/application-form-input-handler.js';
import { deriveEditorReadiness } from '../src/ui/editor-readiness.js';
import { pdfkitBasicEditSections } from '../src/ui/editor-inspector/pdfkit-basic-edit-sections.js';
import { pageTextResult } from '../src/ui/editor-result-pdfkit.js';

function readyState(overrides = {}) {
  return {
    analysis: {
      status: 'ready', documentId: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64),
      inspection: { pageCount: 2, encrypted: 'no', form: 'none', javascript: 'no' },
      structure: { xmpMetadata: { present: false }, urls: [] }, attachments: [],
      signatures: { status: 'unsigned', signatureCount: 0 }, textPages: [], thumbnails: [], fonts: [], images: [],
    },
    host: { pageTextReady: true, engines: [] }, busyAction: null, selectedPage: 2,
    pageTextRun: { x: 36, y: 72, size: 12, text: 'Hello PDF' }, ...overrides,
  };
}

test('page-text controller sends one exact selected-page text run', async () => {
  const state = readyState(); const calls = []; const confirmations = [];
  const operation = { documentId: state.analysis.documentId, controller: new AbortController() };
  const controller = createPdfKitWorkflowController({
    state, client: { async runPageText(documentId, digest, request, options) {
      calls.push({ documentId, digest, request, options });
      return { kind: 'pdf-page-text-run', artifact: { displayName: 'page-text.pdf' }, text: { page: 2 } };
    } },
    captureOperation: () => operation, operationIsCurrent: () => true,
    reportOperationError: (error) => { throw error; }, finishOperation: () => { state.busyAction = null; },
    render: () => {}, announce: () => {}, showError: (error) => { throw error; },
    downloadDerivedArtifact: async () => true, downloadEphemeralDerivedArtifact: async () => true,
    confirm: (message) => { confirmations.push(message); return true; },
  });
  await controller.runPageText();
  assert.deepEqual(calls[0].request, { page: 2, x: 36, y: 72, size: 12, text: 'Hello PDF' });
  assert.match(confirmations[0], /printable ASCII only/);
  assert.match(confirmations[0], /content-empty with no resources/);
  assert.equal(state.pageTextResult?.kind, 'pdf-page-text-run');
});

test('page-text UI communicates the fixed append-only boundary and validates input', () => {
  const state = readyState();
  const readiness = deriveEditorReadiness(state, state.analysis);
  assert.equal(readiness.pageTextReady, true);
  const html = pdfkitBasicEditSections(state, {
    ...readiness, incrementalNamedDestinationPageCount: 0, pdfkitCurrentRotation: null,
  });
  assert.match(html, /data-action="create-page-text-copy" >Create append-only page-text PDF/);
  assert.match(html, /Printable ASCII only/);
  assert.match(html, /one black Helvetica text run/);
  assert.match(html, /content-empty page with no resources/);
  assert.match(html, /historical bytes are retained/);
  assert.match(html, /not general text editing/);
  const renderedResult = pageTextResult({ pageTextResult: {
    kind: 'pdf-page-text-run', artifact: { displayName: 'page-text.pdf' },
    text: { page: 2, size: 12 }, limitations: [],
  } });
  assert.match(renderedResult, /Historical bytes remain retained/);
  const invalid = readyState({ pageTextRun: { x: 36.5, y: 72, size: 12, text: 'Hello PDF' } });
  assert.equal(deriveEditorReadiness(invalid, invalid.analysis).pageTextReady, false);
  const signed = readyState({ analysis: { ...readyState().analysis, signatures: { status: 'signed', signatureCount: 1 } } });
  assert.equal(deriveEditorReadiness(signed, signed.analysis).pageTextReady, false);
});

test('page-text state, form input, and document reset use bounded defaults', () => {
  const state = { ...pdfKitAppState(), analysis: readyState().analysis, pageTextResult: { kind: 'stale' } };
  assert.deepEqual(state.pageTextRun, { x: 36, y: 36, size: 12, text: '' });
  const handleInput = createApplicationInputHandler({
    state, ocr: {}, viewer: {}, documentApi: {}, render: () => {},
  });
  handleInput({ target: { value: 'Hello PDF', matches: (selector) => selector === '#page-text-value' } });
  assert.equal(state.pageTextRun.text, 'Hello PDF');
  assert.equal(state.pageTextResult, null);
  state.pageTextRun = { x: 10, y: 20, size: 24, text: 'Changed' };
  state.pageTextResult = { kind: 'pdf-page-text-run' };
  resetDocumentState(state, () => {}, { opening: false });
  assert.deepEqual(state.pageTextRun, { x: 36, y: 36, size: 12, text: '' });
  assert.equal(state.pageTextResult, null);
});

test('AcroForm radio input accepts only explicit rectangle fields', () => {
  const entry = { label: 'A', page: '1', rect: { x: '10', y: '20', width: '30', height: '40' } };
  const state = { busyAction: null, acroFormRadioOptions: [entry], acroFormStatus: 'ready' };
  const handleInput = createApplicationInputHandler({
    state, ocr: {}, viewer: {}, documentApi: {}, render: () => {},
  });
  const radioTarget = (field, value) => ({
    value,
    dataset: { acroformRadioIndex: '0', acroformRadioField: field },
    matches: (selector) => selector === '[data-acroform-radio-field]',
  });

  handleInput({ target: radioTarget('x', '12') });
  assert.equal(entry.rect.x, '12');

  const originalPrototype = Object.getPrototypeOf(entry.rect);
  handleInput({ target: radioTarget('__proto__', 'polluted') });
  assert.equal(Object.getPrototypeOf(entry.rect), originalPrototype);
  assert.equal(Object.hasOwn(entry.rect, '__proto__'), false);
});
