import { resetDocumentState } from './state-reset.js';

function abortDocumentOperation(context, message) {
  const documentOperations = context.getDocumentOperations();
  documentOperations?.activeController?.abort(new Error(message));
  if (documentOperations) {
    documentOperations.activeController = null;
  }
}

function resetViewerResources(context, reason) {
  context.revokeThumbnails();
  context.resetControlledRaster(reason);
  context.resetLoupe(reason);
}

async function openDocument(context, file) {
  const {
    state,
    session,
    lifecycle,
    clearOcrLayoutSelection,
    removeHostDocument,
    analyzeFile,
    render,
    announce,
    showError,
  } = context;
  const operationGeneration = ++lifecycle.generation;
  const previousDocumentId = state.analysis.documentId;
  lifecycle.analysisController?.abort(new Error('A newer document was opened.'));
  const controller = new AbortController();
  lifecycle.analysisController = controller;
  abortDocumentOperation(context, 'A newer document was opened.');
  state.busyAction = null;
  state.canCancel = false;
  resetViewerResources(context, 'A newer document was opened.');
  await removeHostDocument(previousDocumentId);
  if (operationGeneration !== lifecycle.generation) return;
  try {
    state.document = await session.open(file, {
      shouldCommit: () => operationGeneration === lifecycle.generation,
    });
    resetDocumentState(state, clearOcrLayoutSelection, { opening: true });
    announce(`${state.document.name} opened locally.`);
    render();
    await analyzeFile(file, operationGeneration, controller.signal);
  } catch (error) {
    if (operationGeneration === lifecycle.generation) {
      lifecycle.analysisController = null;
      showError(error);
    }
  }
}

async function closeDocument(context) {
  const {
    state,
    session,
    lifecycle,
    clearOcrLayoutSelection,
    removeHostDocument,
    render,
    announce,
  } = context;
  lifecycle.generation += 1;
  lifecycle.analysisController?.abort(new Error('The document was closed.'));
  lifecycle.analysisController = null;
  abortDocumentOperation(context, 'The document was closed.');
  const documentId = state.analysis.documentId;
  resetViewerResources(context, 'The document was closed.');
  state.document = session.close();
  resetDocumentState(state, clearOcrLayoutSelection, { opening: false });
  announce('Local PDF closed and private session data scheduled for deletion.');
  render();
  await removeHostDocument(documentId);
}

function disposeDocumentSession(context) {
  const {
    state,
    session,
    client,
    lifecycle,
  } = context;
  lifecycle.generation += 1;
  lifecycle.analysisController?.abort(new Error('The window is closing.'));
  lifecycle.analysisController = null;
  abortDocumentOperation(context, 'The window is closing.');
  const documentId = state.analysis.documentId;
  const temporaryDocumentIds = [...state.ocrBatchTemporaryDocumentIds];
  resetViewerResources(context, 'The window is closing.');
  session.dispose();
  if (documentId && client.connected) {
    void client.deleteDocument(documentId, { keepalive: true }).catch(() => {});
  }
  for (const temporaryDocumentId of temporaryDocumentIds) {
    if (client.connected) {
      void client.deleteDocument(temporaryDocumentId, { keepalive: true }).catch(() => {});
    }
  }
}

export function createDocumentSessionController(options) {
  const context = { ...options };
  async function openFile(file) {
    return openDocument(context, file);
  }
  async function closeFile() {
    return closeDocument(context);
  }
  function dispose() {
    return disposeDocumentSession(context);
  }
  return Object.freeze({ openFile, closeFile, dispose });
}
