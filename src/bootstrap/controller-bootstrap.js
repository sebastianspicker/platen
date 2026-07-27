import { createAecWorkflowController } from '../controllers/aec-workflow-controller.js';
import { createAcroFormWorkflowController } from '../controllers/acroform-workflow-controller.js';
import { createComparisonWorkflowController } from '../controllers/comparison-workflow-controller.js';
import { createDocumentGenerationController } from '../controllers/document-generation-controller.js';
import { createDocumentLifecycleController } from '../controllers/document-lifecycle-controller.js';
import { createDomainWorkspaceController } from '../controllers/domain-workspace-controller.js';
import { createOcrWorkflowController } from '../controllers/ocr-workflow-controller.js';
import { createPageCompositionController } from '../controllers/page-composition-controller.js';
import { createPdfKitWorkflowController } from '../controllers/pdfkit-workflow-controller.js';
import { createPluginPlatformController } from '../controllers/plugin-platform-controller.js';
import { createRasterWorkflowController } from '../controllers/raster-workflow-controller.js';
import { createReviewWorkflowController } from '../controllers/review-workflow-controller.js';
import { createScannerDiscoveryController } from '../controllers/scanner-discovery-controller.js';
import { createBatesWorkflowController } from '../controllers/bates-workflow-controller.js';
import { createViewerController } from '../controllers/viewer-controller.js';

export function createInitialControllers({ state, client, callbacks }) {
  const viewer = createViewerController({ state, client, ...callbacks });
  const aec = createAecWorkflowController({
    state, client, ...callbacks,
  });
  const review = createReviewWorkflowController({
    state, client, ...callbacks,
  });
  const scanner = createScannerDiscoveryController({ state, client, ...callbacks });
  return { viewer, aec, review, scanner };
}

export function createDocumentControllers({ state, session, client, callbacks, initial, getRaster }) {
  const lifecycle = createDocumentLifecycleController({
    state,
    session,
    client,
    getDocumentOperations: callbacks.getDocumentOperations,
    render: callbacks.render,
    announce: callbacks.announce,
    showError: callbacks.showError,
    revokeThumbnails: initial.viewer.revokeThumbnails,
    resetControlledRaster: initial.viewer.resetControlledRaster,
    resetLoupe: initial.viewer.resetLoupe,
    clearOcrLayoutSelection: callbacks.clearOcrLayoutSelection,
    syncAecRecordIds: initial.aec.syncAecRecordIds,
    syncRedactionPlans: (workspace) => getRaster().raster.syncRedactionPlans(workspace),
    updateSearchResults: initial.viewer.updateSearchResults,
    urlApi: URL,
  });
  const generation = createDocumentGenerationController({
    state, client, ...callbacks, connectLocalHost: lifecycle.connectLocalHost, openFile: lifecycle.openFile, removeHostDocument: lifecycle.removeHostDocument,
  });
  const domain = createDomainWorkspaceController({
    state, client, ...callbacks, connectLocalHost: lifecycle.connectLocalHost, openFile: lifecycle.openFile, removeHostDocument: lifecycle.removeHostDocument, syncAecRecordIds: initial.aec.syncAecRecordIds,
  });
  const ocr = createOcrWorkflowController({
    state, client, ...callbacks, getDocumentOperations: callbacks.getDocumentOperations, removeHostDocument: lifecycle.removeHostDocument,
  });
  return { lifecycle, generation, domain, ocr };
}

export function createWorkflowControllers({ state, client, callbacks, initial, documentControllers }) {
  const raster = createRasterWorkflowController({ state, client, ...callbacks });
  const comparison = createComparisonWorkflowController({
    state, client, ...callbacks, removeHostDocument: documentControllers.lifecycle.removeHostDocument,
  });
  const pageComposition = createPageCompositionController({
    state,
    client,
    ...callbacks,
    getActiveController: () => callbacks.getDocumentOperations()?.activeController,
    removeHostDocument: documentControllers.lifecycle.removeHostDocument,
    selectPage: initial.viewer.selectPage,
    setSelectedPageIdentity: initial.viewer.setSelectedPageIdentity,
  });
  const pdfkit = createPdfKitWorkflowController({ state, client, ...callbacks });
  const acroform = createAcroFormWorkflowController({ state, client, ...callbacks });
  const pluginPlatform = createPluginPlatformController({
    state,
    client,
    connectLocalHost: documentControllers.lifecycle.connectLocalHost,
    render: callbacks.render,
    announce: callbacks.announce,
    showError: callbacks.showError,
  });
  const bates = createBatesWorkflowController({ state, client, ...callbacks });
  return { raster, comparison, pageComposition, pdfkit, acroform, bates, pluginPlatform };
}
