import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfKitWorkflowController } from '../src/controllers/pdfkit-workflow-controller.js';
import { editorView } from '../src/ui/editor-view.js';
import { fullPdfKitState } from './support/view-render-pdfkit-states.js';
import { createApplicationClickActions } from '../src/ui/application-click-actions.js';

const digest = 'a'.repeat(64);
function controllerFixture(overrides = {}) {
  const state = {
    analysis: { documentId: 'doc', sha256: digest, status: 'ready', inspection: { pageCount: 1, form: 'none' }, structure: {}, attachments: [], signatures: { status: 'unsigned', signatureCount: 0 }, textPages: [], fonts: [], images: [] },
    host: { pdfkitInspectionReady: true, layerDefaultsReady: true }, busyAction: null, selectedPage: 1,
    pdfkitLayerGroups: [], pdfkitLayerVisibility: [], pdfkitLayerInspectionDigest: null, pdfkitLayerStatus: 'idle', pdfkitLayerResult: null, ...overrides,
  };
  const calls = []; const operation = { documentId: 'doc', controller: new AbortController() };
  const operationCurrent = overrides.operationIsCurrent ?? (() => true);
  const controller = createPdfKitWorkflowController({
    state,
    client: {
      async runPdfKitInspection() { return { kind: 'pdfkit-structure-inspection', sourceDigest: digest, pageCount: 1, pages: [], optionalContent: { present: true, groupCount: 2, groupsTruncated: false, defaultConfigurationPresent: true, groups: [{ index: 0, name: 'Base', defaultVisible: true }, { index: 1, name: 'Notes', defaultVisible: false }] } }; },
      async runLayerDefaults(...args) { calls.push(args); if (overrides.layerError) throw overrides.layerError; return { kind: 'pdf-layer-defaults', artifact: { displayName: 'layered.pdf' }, proof: { visibleGroupIndices: [0], hiddenGroupIndices: [1] } }; },
    },
    captureOperation: () => operation, operationIsCurrent: operationCurrent, reportOperationError: (error) => { if (!overrides.captureErrors) throw error; calls.push(['error', error]); }, finishOperation: () => { state.busyAction = null; }, render() {}, announce() {}, downloadDerivedArtifact: async () => true, downloadEphemeralDerivedArtifact: async () => true,
  });
  return { state, controller, calls };
}

test('layer controller binds inspected defaults, emits ordered changes, and downloads a derived copy', async () => {
  const { state, controller, calls } = controllerFixture();
  await controller.runPdfKitInspection();
  assert.deepEqual(state.pdfkitLayerVisibility, [true, false]);
  controller.setLayerVisibility(0, false);
  await controller.runLayerDefaults();
  assert.deepEqual(calls[0][2], [{ groupIndex: 0, visible: false }]);
  assert.equal(state.pdfkitLayerStatus, 'success');
});

test('layer controller rejects stale and duplicate inspection inventories', () => {
  const { state, controller } = controllerFixture();
  assert.throws(() => controller.syncLayerInspection({ kind: 'pdfkit-structure-inspection', sourceDigest: 'b'.repeat(64), optionalContent: { present: true, groupCount: 1, groups: [{ index: 0, defaultVisible: true }], groupsTruncated: false, defaultConfigurationPresent: true } }), { code: 'STALE_PDFKIT_INSPECTION' });
  assert.throws(() => controller.syncLayerInspection({ kind: 'pdfkit-structure-inspection', sourceDigest: digest, optionalContent: { present: true, groupCount: 2, groups: [{ index: 0, defaultVisible: true }, { index: 0, defaultVisible: false }], groupsTruncated: false, defaultConfigurationPresent: true } }), { code: 'INVALID_PDFKIT_LAYER_INSPECTION' });
  assert.throws(() => controller.syncLayerInspection({ kind: 'pdfkit-structure-inspection', sourceDigest: digest, optionalContent: { present: true, groupCount: 1, groups: [{ index: 0, name: '\uE000', defaultVisible: true }], groupsTruncated: false, defaultConfigurationPresent: true } }), { code: 'INVALID_PDFKIT_LAYER_INSPECTION' });
  assert.throws(() => controller.syncLayerInspection({ kind: 'pdfkit-structure-inspection', sourceDigest: digest, optionalContent: { present: true, groupCount: 1, groups: [{ index: 0, name: 'x'.repeat(128), defaultVisible: true }], groupsTruncated: false, defaultConfigurationPresent: true } }), { code: 'INVALID_PDFKIT_LAYER_INSPECTION' });
  assert.deepEqual(state.pdfkitLayerGroups, []);
});

test('layer controller suppresses stale results and records cancellation/error states', async () => {
  let staleChecks = 0;
  const stale = controllerFixture({ operationIsCurrent: () => staleChecks++ === 0 });
  await stale.controller.runPdfKitInspection();
  stale.controller.setLayerVisibility(0, false);
  await stale.controller.runLayerDefaults();
  assert.equal(stale.state.pdfkitLayerResult, null);
  const cancelled = controllerFixture({ captureErrors: true, layerError: Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' }) });
  await cancelled.controller.runPdfKitInspection();
  cancelled.controller.setLayerVisibility(0, false);
  await cancelled.controller.runLayerDefaults();
  assert.equal(cancelled.state.pdfkitLayerStatus, 'cancelled');
  const failed = controllerFixture({ captureErrors: true, layerError: Object.assign(new Error('broken'), { code: 'PDF_LAYER_DEFAULTS_FAILED' }) });
  await failed.controller.runPdfKitInspection();
  failed.controller.setLayerVisibility(0, false);
  await failed.controller.runLayerDefaults();
  assert.equal(failed.state.pdfkitLayerStatus, 'error');
  assert.equal(failed.state.pdfkitLayerError, 'broken');
});

test('layer panel exposes accessible toggles and honest unavailable state', () => {
  const current = fullPdfKitState();
  current.host.layerDefaultsReady = true;
  const html = editorView(current);
  assert.match(html, /Optional-content layers/);
  assert.match(html, /id="pdfkit-layer-0" type="checkbox"/);
  assert.match(html, /data-action="reset-pdfkit-layers"/);
  assert.match(html, /data-action="apply-pdfkit-layers" disabled/);
  const unavailable = fullPdfKitState();
  unavailable.host.layerDefaultsReady = false;
  const unavailableHtml = editorView(unavailable);
  assert.match(unavailableHtml, /local layer-defaults service is unavailable/);
  assert.match(unavailableHtml, /data-action="apply-pdfkit-layers" disabled/);
});

test('layer action router exposes reset and apply handlers', () => {
  const calls = [];
  const actions = createApplicationClickActions({
    state: {}, controllers: {
      viewer: {}, lifecycle: {}, generation: {}, domain: {}, aec: {}, pageComposition: {}, comparison: {}, ocr: {}, raster: {}, review: {},
      pdfkit: { resetLayerVisibility: () => calls.push('reset'), runLayerDefaults: () => calls.push('apply') }, pluginPlatform: {}, documentOperations: {},
    },
    documentApi: {}, windowApi: {}, render() {}, announce() {}, showError() {}, downloadOriginal() {}, exportText() {}, exportStructuredText() {},
  });
  actions['reset-pdfkit-layers']();
  actions['apply-pdfkit-layers']();
  assert.deepEqual(calls, ['reset', 'apply']);
});
