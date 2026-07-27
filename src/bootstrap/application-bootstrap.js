import { CapabilityRegistry } from '../core/capability-registry.js';
import { createAppState } from '../core/app-state.js';
import { DocumentOperationCoordinator } from '../core/document-operation-coordinator.js';
import { DocumentSession } from '../core/document-session.js';
import { createDocumentTabs } from '../core/document-tabs.js';
import { LocalHostClient } from '../core/local-host-client.js';
import { bindApplicationClickEvents } from '../ui/application-click-router.js';
import { bindApplicationFormEvents } from '../ui/application-form-router.js';
import { bindApplicationShellEvents } from '../ui/application-shell-events.js';
import { escapeHtml } from '../ui/shared.js';
import { createApplicationPresentation } from './application-presentation.js';
import { createDocumentOperationBridge } from './document-operation-bridge.js';
import { createDocumentControllers, createInitialControllers, createWorkflowControllers } from './controller-bootstrap.js';
import { createViewerMultiDocumentTabsController } from '../controllers/viewer/multidocument-tabs-controller.js';

async function loadCatalog(state, render) {
  const paths = ['/catalog/families.json', '/catalog/packs.json', '/catalog/capabilities.json', '/catalog/prototype-coverage.json'];
  const responses = await Promise.all(paths.map((path) => fetch(path)));
  for (const response of responses) {
    if (!response.ok) throw new Error(`Could not load ${response.url} (${response.status}).`);
  }
  const [families, packs, capabilities, prototypeCoverage] = await Promise.all(responses.map((response) => response.json()));
  state.registry = new CapabilityRegistry({ families, packs, capabilities });
  if (!Array.isArray(prototypeCoverage?.records)
    || prototypeCoverage.records.length !== capabilities.length
    || prototypeCoverage.records.some((record, index) => record.id !== capabilities[index].id || record.delivery !== capabilities[index].delivery)) {
    throw new Error('Prototype coverage does not match the professional capability catalog.');
  }
  state.prototypeCoverage = Object.freeze(Object.fromEntries(prototypeCoverage.records.map((record) => [record.id, Object.freeze(record)])));
  state.prototypeSummary = Object.freeze(prototypeCoverage.records.reduce((summary, { tier }) => {
    summary[tier] = (summary[tier] ?? 0) + 1;
    return summary;
  }, {}));
  state.summary = state.registry.summary;
  render();
}

function createOperationCoordinator({ state, client, lifecycle, presentation }) {
  return new DocumentOperationCoordinator({
    getGeneration: () => lifecycle.generation,
    getDocumentId: () => state.analysis.documentId,
    client,
    onCapture: () => { state.canCancel = true; },
    onFinish: () => { state.canCancel = false; state.busyAction = null; presentation.render(); },
    onCancelled: () => { state.error = null; presentation.announce('Local operation cancelled. The source PDF is unchanged.'); },
    onError: presentation.showError,
    onCancel: () => {
      state.canCancel = false;
      state.busyAction = 'Cancelling local operation…';
      presentation.announce('Cancelling the local operation.');
      presentation.render();
    },
    onDownload: presentation.triggerDownload,
  });
}

export function startApplication(documentApi = document) {
  const root = documentApi.querySelector('#app');
  const liveRegion = documentApi.querySelector('#live-region');
  const session = new DocumentSession();
  const tabStore = createDocumentTabs();
  const client = new LocalHostClient();
  const state = createAppState({
    documentSnapshot: session.snapshot,
    snapshotClipboardReady: Boolean(globalThis.navigator?.clipboard?.write && typeof globalThis.ClipboardItem === 'function'),
  });
  const presentation = createApplicationPresentation({ root, liveRegion, state, session });
  const bridge = createDocumentOperationBridge();
  let documentControllers;
  const callbacks = {
    ...presentation,
    ...bridge,
    captureOperation: bridge.captureDocumentOperation,
    operationIsCurrent: bridge.operationIsCurrent,
    reportOperationError: bridge.reportOperationError,
    finishOperation: bridge.finishDocumentOperation,
    clearOcrLayoutSelection: () => documentControllers.ocr.clearOcrLayoutSelection(),
  };
  const initial = createInitialControllers({ state, client, callbacks });
  let workflowControllers;
  documentControllers = createDocumentControllers({
    state, session, client, callbacks, initial, getRaster: () => workflowControllers,
  });
  const tabs = createViewerMultiDocumentTabsController({
    state,
    tabs: tabStore,
    lifecycle: documentControllers.lifecycle,
    render: presentation.render,
    announce: presentation.announce,
    showError: presentation.showError,
  });
  const unsubscribeTabs = tabStore.subscribe((snapshot) => {
    state.documentTabs = snapshot;
    presentation.render();
  });
  workflowControllers = createWorkflowControllers({ state, client, callbacks, initial, documentControllers });
  const documentOperations = createOperationCoordinator({
    state, client, lifecycle: documentControllers.lifecycle, presentation,
  });
  bridge.setDocumentOperations(documentOperations);
  const controllers = Object.freeze({
    viewer: initial.viewer,
    lifecycle: documentControllers.lifecycle,
    generation: documentControllers.generation,
    domain: documentControllers.domain,
    aec: initial.aec,
    pageComposition: workflowControllers.pageComposition,
    comparison: workflowControllers.comparison,
    ocr: documentControllers.ocr,
    raster: workflowControllers.raster,
    review: initial.review,
    scanner: initial.scanner,
    pdfkit: workflowControllers.pdfkit,
    acroform: workflowControllers.acroform,
    bates: workflowControllers.bates,
    pluginPlatform: workflowControllers.pluginPlatform,
    documentOperations,
    tabs,
  });
  bindApplicationClickEvents({ root, state, controllers, ...presentation });
  bindApplicationFormEvents({ root, state, controllers, render: presentation.render });
  bindApplicationShellEvents({
    root,
    state,
    session,
    lifecycle: documentControllers.lifecycle,
    generation: documentControllers.generation,
    tabs,
    render: presentation.render,
  });
  documentControllers.lifecycle.connectLocalHost().catch(() => {});
  loadCatalog(state, presentation.render).catch((error) => {
    root.setAttribute('aria-busy', 'false');
    root.innerHTML = `<main class="fatal-state"><h1>Platen could not start</h1><p>${escapeHtml(error.message || error)}</p><p>Serve the project with <code>npm run dev</code>.</p></main>`;
  });
}
