import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcroFormWorkflowController } from '../src/controllers/acroform-workflow-controller.js';
import { editorView } from '../src/ui/editor-view.js';
import { state as viewState } from './support/view-render-fixture.js';
import { bindApplicationClickEvents } from '../src/ui/application-click-router.js';
import { bindApplicationFormEvents } from '../src/ui/application-form-router.js';
import { resetDocumentState } from '../src/controllers/document-lifecycle/state-reset.js';

const digest = 'a'.repeat(64);
function fixture(overrides = {}) {
  const state = {
    analysis: { status: 'ready', documentId: 'document-1', sha256: digest, inspection: { pageCount: 3 }, signatures: { status: 'unsigned', signatureCount: 0 } },
    host: { acroFormCheckboxReady: true, acroFormRadioReady: true, acroFormTextFieldReady: true }, busyAction: null,
    acroFormTextFieldName: 'name', acroFormTextFieldPage: '1', acroFormTextFieldRect: { x: 10, y: 70, width: 100, height: 20 },
    acroFormCheckboxFieldName: 'check', acroFormCheckboxPage: '2', acroFormCheckboxRect: { x: 10, y: 20, width: 18, height: 18 },
    acroFormRadioGroupName: 'choice', acroFormRadioOptions: [
      { label: 'A', page: '1', rect: { x: 10, y: 20, width: 18, height: 18 } },
      { label: 'B', page: '1', rect: { x: 10, y: 48, width: 18, height: 18 } },
    ], acroFormStatus: 'idle', acroFormError: null, acroFormResult: null, ...overrides,
  };
  const calls = []; const downloads = []; const operation = { documentId: 'document-1', controller: new AbortController() };
  const deferred = { resolve: null, reject: null };
  const client = {
    async addAcroFormCheckbox(...args) { calls.push(['checkbox', ...args]); return { kind: 'pdf-acroform-checkbox', artifact: { displayName: 'checkbox.pdf' } }; },
    async addAcroFormRadio(...args) { calls.push(['radio', ...args]); if (overrides.deferRadio) return new Promise((resolve, reject) => { deferred.resolve = resolve; deferred.reject = reject; }); return { kind: 'pdf-acroform-radio', artifact: { displayName: 'radio.pdf' } }; },
    async addAcroFormTextField(...args) { calls.push(['text-field', ...args]); return { kind: 'pdf-acroform-text-field', artifact: { displayName: 'text.pdf' } }; },
  };
  const controller = createAcroFormWorkflowController({
    state, client, captureOperation: () => operation, operationIsCurrent: overrides.operationIsCurrent ?? (() => true), reportOperationError: (error) => { calls.push(['error', error]); }, finishOperation: () => { state.busyAction = null; }, render() {}, announce() {}, downloadDerivedArtifact: async (...args) => { downloads.push(args); return true; },
  });
  return { state, controller, calls, downloads, deferred };
}

test('checkbox and radio controllers bind current document digest and canonical request shape', async () => {
  const value = fixture();
  await value.controller.runCheckbox();
  assert.deepEqual(value.calls[0][2], { profile: 'local-pdf-acroform-checkbox-v1', sourceSha256: digest, page: 2, fieldName: 'check', rect: { x: 10, y: 20, width: 18, height: 18 } });
  assert.equal(value.calls[0][1], 'document-1');
  assert(value.calls[0][3].signal instanceof AbortSignal);
  await value.controller.runRadio();
  assert.deepEqual(value.calls[1][2], { profile: 'local-pdf-acroform-radio-v1', sourceSha256: digest, groupName: 'choice', options: value.state.acroFormRadioOptions.map((entry) => ({ ...entry, page: 1, rect: { ...entry.rect, x: 10, y: Number(entry.rect.y), width: 18, height: 18 } })) });
  assert.equal(value.state.acroFormStatus, 'success');
  assert.equal(value.downloads.length, 2);
  await value.controller.runTextField();
  assert.deepEqual(value.calls[2][2], { profile: 'local-pdf-acroform-text-field-v1', sourceSha256: digest, page: 1, fieldName: 'name', rect: { x: 10, y: 70, width: 100, height: 20 } });
});

test('radio UI rejects duplicate labels and page rectangles before transport', async () => {
  const duplicateLabel = fixture({ acroFormRadioOptions: [{ label: 'A', page: '1', rect: { x: 1, y: 1, width: 2, height: 2 } }, { label: 'A', page: '2', rect: { x: 1, y: 1, width: 2, height: 2 } }] });
  await duplicateLabel.controller.runRadio();
  assert.equal(duplicateLabel.calls.length, 0); assert.equal(duplicateLabel.state.acroFormStatus, 'error');
  const duplicateRect = fixture({ acroFormRadioOptions: [{ label: 'A', page: '1', rect: { x: 1, y: 1, width: 2, height: 2 } }, { label: 'B', page: '1', rect: { x: 1, y: 1, width: 2, height: 2 } }] });
  await duplicateRect.controller.runRadio();
  assert.equal(duplicateRect.calls.length, 0); assert.equal(duplicateRect.state.acroFormStatus, 'error');
});

test('async form requests snapshot mutable state and suppress stale completion/cancellation downloads', async () => {
  const pending = fixture({ deferRadio: true });
  const run = pending.controller.runRadio();
  pending.state.acroFormRadioOptions[0].label = 'Changed after click';
  pending.deferred.resolve({ kind: 'pdf-acroform-radio', artifact: { displayName: 'radio.pdf' } });
  await run;
  assert.equal(pending.calls[0][2].options[0].label, 'A');
  const stale = fixture({ operationIsCurrent: () => false });
  await stale.controller.runCheckbox();
  assert.equal(stale.downloads.length, 0); assert.equal(stale.state.acroFormResult, null); assert.equal(stale.state.acroFormStatus, 'idle');
  const cancelled = fixture({ deferRadio: true });
  const cancelledRun = cancelled.controller.runRadio();
  cancelled.deferred.reject(Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }));
  await cancelledRun;
  assert.equal(cancelled.downloads.length, 0); assert.equal(cancelled.state.acroFormStatus, 'cancelled');
});

test('form controls render escaped keyboard-native inputs and disabled unavailable states', () => {
  const current = viewState({
    document: { isOpen: true, name: 'form.pdf', size: 4096, type: 'application/pdf', objectUrl: 'blob:form', modified: false },
    host: { status: 'ready', acroFormCheckboxReady: true, acroFormRadioReady: true, acroFormTextFieldReady: true, pdfkitInspectionReady: false, engines: [] },
    analysis: { status: 'ready', documentId: 'doc', sha256: digest, inspection: { pageCount: 2, form: 'none' }, signatures: { status: 'unsigned', signatureCount: 0 }, structure: {}, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [] },
    acroFormCheckboxFieldName: '<check>', acroFormRadioGroupName: '<group>', acroFormRadioOptions: [{ label: '<A>', page: '1', rect: { x: 1, y: 1, width: 2, height: 2 } }, { label: 'B', page: '1', rect: { x: 1, y: 5, width: 2, height: 2 } }],
  });
  const html = editorView(current);
  assert.match(html, /Create form controls/); assert.match(html, /Passive text field/); assert.match(html, /&lt;check&gt;/); assert.match(html, /&lt;A&gt;/); assert.match(html, /type="checkbox"/); assert.match(html, /data-action="add-acroform-radio-option"/); assert.match(html, /data-action="create-acroform-radio"/); assert.match(html, /data-action="create-acroform-text-field"/);
  const unavailable = viewState({ ...current, host: { status: 'ready', acroFormCheckboxReady: false, acroFormRadioReady: false, engines: [] } });
  assert.match(editorView(unavailable), /passive AcroForm authoring services are unavailable/); assert.match(editorView(unavailable), /data-action="create-acroform-checkbox" disabled/);
});

test('radio option rows can be added and removed without exceeding the strict bound', () => {
  const value = fixture();
  value.controller.addRadioOption();
  assert.equal(value.state.acroFormRadioOptions.length, 3);
  value.controller.removeRadioOption(2);
  assert.equal(value.state.acroFormRadioOptions.length, 2);
  value.controller.removeRadioOption(0);
  assert.equal(value.state.acroFormRadioOptions.length, 2);
  value.controller.removeRadioOption(-1);
  value.controller.removeRadioOption(Number.NaN);
  assert.equal(value.state.acroFormRadioOptions.length, 2);
});

test('application action and form routers dispatch AcroForm controls', async () => {
  const listeners = new Map(); const root = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener() {} };
  const calls = []; const formState = { acroFormCheckboxFieldName: '', acroFormStatus: 'idle', acroFormError: null, acroFormResult: null }; const acroform = { runCheckbox: () => calls.push('checkbox'), runRadio: () => calls.push('radio'), runTextField: () => calls.push('text-field'), addRadioOption: () => calls.push('add'), removeRadioOption: (index) => calls.push(['remove', index]), updateCheckboxFieldName: (value) => calls.push(['name', value]), updateRadioOption: (index, key, value) => calls.push(['option', index, key, value]), updateTextFieldName: (value) => calls.push(['text-name', value]) };
  const controllers = { viewer: {}, lifecycle: {}, generation: {}, domain: {}, aec: {}, pageComposition: {}, comparison: {}, ocr: { updateSelectedOcrZone() {}, clearOcrLayoutSelection() {}, setOcrBatchFiles() {}, setOcrSuspectReviewState() {} }, raster: {}, review: {}, pdfkit: {}, acroform, pluginPlatform: {}, documentOperations: {} };
  const callbacks = { root, state: formState, controllers, document: { querySelector: () => null }, window: { print() {} }, render() {}, announce() {}, showError() {}, downloadOriginal() {}, exportText() {}, exportStructuredText() {} };
  bindApplicationClickEvents(callbacks);
  const click = listeners.get('click');
  for (const action of ['create-acroform-checkbox', 'create-acroform-radio', 'create-acroform-text-field', 'add-acroform-radio-option']) await click({ target: { closest: (selector) => selector === '[data-action]' ? { dataset: { action } } : null } });
  await click({ target: { closest: (selector) => selector === '[data-action]' ? { dataset: { action: 'remove-acroform-radio-option', acroformRadioIndex: '1' } } : null } });
  bindApplicationFormEvents({ ...callbacks, render() {}, document: { querySelector: () => null } });
  const input = listeners.get('input');
  input({ target: { value: 'new-name', matches: (selector) => selector === '#acroform-checkbox-field-name' } });
  assert.deepEqual(calls, ['checkbox', 'radio', 'text-field', 'add', ['remove', 1]]);
  assert.equal(formState.acroFormCheckboxFieldName, 'new-name');
});

test('document reset clears mutable AcroForm state and results', () => {
  const value = fixture();
  value.state.acroFormCheckboxFieldName = 'changed';
  value.state.acroFormRadioOptions = [{ label: 'x' }];
  value.state.acroFormStatus = 'success';
  value.state.acroFormResult = { artifact: { displayName: 'x.pdf' } };
  value.state.pdfkitExistingAnnotationStrokeColor = '#000000';
  resetDocumentState(value.state, () => {}, { opening: false });
  assert.equal(value.state.acroFormCheckboxFieldName, 'check-1');
  assert.equal(value.state.acroFormRadioOptions.length, 2);
  assert.equal(value.state.acroFormStatus, 'idle');
  assert.equal(value.state.acroFormResult, null);
  assert.equal(value.state.pdfkitExistingAnnotationStrokeColor, '#d32f2f');
});
