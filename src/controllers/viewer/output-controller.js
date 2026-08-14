import { readAloudText } from '../../core/read-aloud.js';
import {
  clipboardTextWritingAvailable,
  pageTextForClipboard,
} from '../../core/page-text-clipboard.js';
import {
  copyPngToClipboard,
  normalizeSnapshotRegion,
  prepareSnapshotPng,
} from '../../core/snapshot-output.js';

const SHA256_LOWERCASE_HEX = /^[a-f0-9]{64}$/;

function isSourceReadyAnalysis(state) {
  const { analysis } = state;
  return analysis?.status === 'ready'
    && typeof analysis.documentId === 'string'
    && analysis.documentId !== ''
    && typeof analysis.sha256 === 'string'
    && SHA256_LOWERCASE_HEX.test(analysis.sha256);
}

function normalizedStateRegion(state) {
  return normalizeSnapshotRegion(Object.fromEntries(
    ['x', 'y', 'width', 'height'].map((key) => [
      key,
      Number(state.snapshotRegion?.[key]),
    ]),
  ));
}

function documentStem(name) {
  return (name || 'document').replace(/\.pdf$/i, '');
}

function createReadSelectedPage({ state, announce, showError, documentApi, windowApi }) {
  return function readSelectedPage() {
    if (state.busyAction) return;
    if (!isSourceReadyAnalysis(state)) {
      showError(new Error('Read aloud is unavailable until the current document analysis is ready.'));
      return;
    }
    const speech = windowApi.speechSynthesis;
    const Utterance = windowApi.SpeechSynthesisUtterance;
    const text = readAloudText(state.analysis.textPages, state.selectedPage);
    if (!speech || typeof Utterance !== 'function' || !text) {
      showError(new Error('Read aloud is unavailable for this page in the current browser.'));
      return;
    }
    speech.cancel();
    const utterance = new Utterance(text);
    utterance.lang = documentApi.documentElement.lang || 'en';
    speech.speak(utterance);
    announce(`Reading page ${state.selectedPage} aloud with the local browser voice.`);
  };
}

function createExportSelectedPageImage({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  triggerDownload,
  render,
}) {
  return async function exportSelectedPageImage() {
    if (!state.analysis.documentId || state.busyAction) return;
    const operation = captureOperation();
    const selectedPage = state.selectedPage;
    const documentName = state.document.name;
    state.busyAction = `Rendering page ${selectedPage} as PNG…`;
    state.error = null;
    render();
    try {
      const blob = await client.thumbnail(operation.documentId, selectedPage, 150, {
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation)) return;
      triggerDownload({
        blob,
        fileName: `${documentStem(documentName)}-page-${selectedPage}.png`,
        message: `Page ${selectedPage} rendered locally as PNG.`,
      });
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  };
}

function createCopySelectedPageText({
  state,
  selectionTracker,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  render,
  announce,
  showError,
  navigatorApi,
}) {
  return async function copySelectedPageText() {
    if (state.busyAction) return;
    if (!isSourceReadyAnalysis(state)) {
      showError(new Error('Page text copy is unavailable until the current analysis is ready.'));
      return;
    }
    const text = pageTextForClipboard(state.analysis.textPages, state.selectedPage);
    if (!text) {
      showError(new Error('No bounded extracted text is available for the selected page.'));
      return;
    }
    if (!clipboardTextWritingAvailable(navigatorApi?.clipboard)) {
      showError(new Error('Text clipboard writing is unavailable in this browser.'));
      return;
    }

    const operation = captureOperation();
    const selectedPage = state.selectedPage;
    const sourceDocumentId = state.analysis.documentId;
    const sourceAnalysisSha256 = state.analysis.sha256;
    const sourceAnalysisStatus = state.analysis.status;
    const pageGeneration = selectionTracker.generation;
    const isCurrent = () => operationIsCurrent(operation)
      && operation.documentId === sourceDocumentId
      && state.analysis.status === sourceAnalysisStatus
      && state.analysis.documentId === sourceDocumentId
      && state.analysis.sha256 === sourceAnalysisSha256
      && state.selectedPage === selectedPage
      && selectionTracker.generation === pageGeneration;
    state.busyAction = `Copying text from page ${selectedPage}…`;
    state.error = null;
    render();
    try {
      if (!isCurrent()) return;
      // Clipboard writes cannot be undone, so a change during this await only suppresses success.
      await navigatorApi.clipboard.writeText(text);
      if (!isCurrent()) return;
      announce(`Text from page ${selectedPage} copied to the clipboard.`);
    } catch (error) {
      if (isCurrent()) reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  };
}

function createOutputSelectedSnapshot({
  state,
  client,
  selectionTracker,
  decodeControlledRaster,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  triggerDownload,
  render,
  announce,
  showError,
}) {
  return async function outputSelectedSnapshot(mode) {
    if (!state.analysis.documentId || state.busyAction || !['copy', 'download', 'export'].includes(mode)) return;
    let region;
    const dpi = Number(state.snapshotDpi);
    try {
      region = normalizedStateRegion(state);
      if (!Number.isSafeInteger(dpi) || dpi < 36 || dpi > 240) throw new TypeError('Snapshot DPI must be an integer from 36 through 240.');
      if (mode === 'copy' && !state.snapshotClipboardReady) throw new Error('PNG clipboard writing is unavailable in this browser. Use Download PNG instead.');
    } catch (error) {
      showError(error);
      return;
    }

    const operation = captureOperation();
    const selectedPage = state.selectedPage;
    const pageGeneration = selectionTracker.generation;
    const documentName = state.document.name;
    state.busyAction = `${mode === 'copy' ? 'Copying' : 'Exporting'} selected page ${selectedPage} region…`;
    state.error = null;
    render();
    const snapshotIsCurrent = () => operationIsCurrent(operation)
      && state.selectedPage === selectedPage
      && selectionTracker.generation === pageGeneration;
    const snapshotPromise = prepareSnapshotPng(
      client.cropBoxSnapshot(operation.documentId, selectedPage, region, dpi, { signal: operation.controller.signal }),
      { isCurrent: snapshotIsCurrent, decodeBlob: decodeControlledRaster },
    );
    try {
      if (mode === 'copy') {
        await copyPngToClipboard(snapshotPromise);
        if (operationIsCurrent(operation)) announce(`Page ${selectedPage} CropBox snapshot copied as PNG.`);
      } else {
        const blob = await snapshotPromise;
        if (!snapshotIsCurrent()) return;
        triggerDownload({
          blob,
          fileName: `${documentStem(documentName)}-page-${selectedPage}-${mode === 'export' ? 'selected-region' : 'snapshot'}.png`,
          message: `Page ${selectedPage} selected region exported as PNG.`,
        });
      }
    } catch (error) {
      if (error?.code === 'SNAPSHOT_STALE' && operationIsCurrent(operation)) {
        state.error = null;
        announce('Snapshot cancelled because the selected page changed.');
      } else {
        reportOperationError(error, operation);
      }
    } finally {
      finishOperation(operation);
    }
  };
}

export function createViewerOutputController({
  state,
  client,
  selectionTracker,
  decodeControlledRaster,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  triggerDownload,
  render,
  announce,
  showError,
  documentApi,
  windowApi,
  navigatorApi,
}) {
  const readSelectedPage = createReadSelectedPage({
    state,
    announce,
    showError,
    documentApi,
    windowApi,
  });
  const exportSelectedPageImage = createExportSelectedPageImage({
    state,
    client,
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    triggerDownload,
    render,
  });
  const copySelectedPageText = createCopySelectedPageText({
    state,
    selectionTracker,
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    render,
    announce,
    showError,
    navigatorApi,
  });
  const outputSelectedSnapshot = createOutputSelectedSnapshot({
    state, client, selectionTracker, decodeControlledRaster, captureOperation, operationIsCurrent,
    reportOperationError, finishOperation, triggerDownload, render, announce, showError,
  });

  return Object.freeze({
    readSelectedPage,
    exportSelectedPageImage,
    copySelectedPageText,
    outputSelectedSnapshot,
  });
}
