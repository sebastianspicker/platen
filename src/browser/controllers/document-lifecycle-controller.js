import { createDocumentAnalysisController } from './document-lifecycle/document-analysis.js';
import { createHostConnectionController } from './document-lifecycle/host-connection.js';
import { createHostDocumentController } from './document-lifecycle/host-documents.js';
import { createDocumentSessionController } from './document-lifecycle/session-controller.js';

export function createDocumentLifecycleController({
  state,
  session,
  client,
  getDocumentOperations,
  render,
  announce,
  showError,
  revokeThumbnails,
  resetControlledRaster,
  resetLoupe,
  clearOcrLayoutSelection,
  syncAecRecordIds,
  syncRedactionPlans,
  updateSearchResults,
  urlApi = globalThis.URL,
}) {
  const callbacks = {
    getDocumentOperations,
    render,
    announce,
    showError,
    revokeThumbnails,
    resetControlledRaster,
    resetLoupe,
    clearOcrLayoutSelection,
    syncAecRecordIds,
    syncRedactionPlans,
    updateSearchResults,
  };
  if (
    !state
    || !session
    || !client
    || Object.values(callbacks).some((callback) => typeof callback !== 'function')
    || typeof urlApi?.createObjectURL !== 'function'
  ) {
    throw new TypeError(
      'Document lifecycle controller requires state, session, client, URL, and callbacks.',
    );
  }

  const lifecycle = { generation: 0, analysisController: null };
  const hostConnection = createHostConnectionController({ state, client, render });
  const hostDocuments = createHostDocumentController({ state, client });
  const analysis = createDocumentAnalysisController({
    state,
    client,
    lifecycle,
    connectLocalHost: hostConnection.connectLocalHost,
    removeHostDocument: hostDocuments.removeHostDocument,
    render,
    announce,
    revokeThumbnails,
    syncAecRecordIds,
    syncRedactionPlans,
    updateSearchResults,
    urlApi,
  });
  const documentSession = createDocumentSessionController({
    state,
    session,
    client,
    lifecycle,
    getDocumentOperations,
    render,
    announce,
    showError,
    revokeThumbnails,
    resetControlledRaster,
    resetLoupe,
    clearOcrLayoutSelection,
    removeHostDocument: hostDocuments.removeHostDocument,
    analyzeFile: analysis.analyzeFile,
  });

  return Object.freeze({
    get generation() {
      return lifecycle.generation;
    },
    connectLocalHost: hostConnection.connectLocalHost,
    removeHostDocument: hostDocuments.removeHostDocument,
    openFile: documentSession.openFile,
    closeFile: documentSession.closeFile,
    dispose: documentSession.dispose,
  });
}
