import { OCR_LIMITS } from '../core/ocr-contract.js';
import { createOcrEvidenceExporter } from './ocr-evidence-exporter.js';
import { createOcrZoneController } from './ocr-zone-controller.js';
import { createOcrBatchDownloadOperations } from './ocr-workflow/batch-download-operations.js';
import { createOcrBatchProcessingOperations } from './ocr-workflow/batch-processing-operations.js';
import { createOcrBatchSelectionOperations } from './ocr-workflow/batch-selection-operations.js';
import { createOcrPageAnalysisOperations } from './ocr-workflow/page-analysis-operations.js';
import { createClipboardCaptureOperations } from './ocr-workflow/clipboard-capture-operations.js';
import { createSearchableCopyOperations } from './ocr-workflow/searchable-copy-operations.js';
import { createOcrSuspectReviewOperations } from './ocr-workflow/suspect-review-operations.js';

export function createOcrWorkflowController({
  state,
  client,
  getDocumentOperations,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  removeHostDocument,
  triggerDownload,
  render,
  announce,
  showError,
  decodeBase64 = globalThis.atob,
  cryptoApi = globalThis.crypto,
  Blob: BlobConstructor = Blob,
  navigatorApi = globalThis.navigator,
  FileCtor = globalThis.File,
}) {
  const callbacks = {
    getDocumentOperations, captureOperation, operationIsCurrent, reportOperationError, finishOperation,
    removeHostDocument, triggerDownload, render, announce, showError,
  };
  if (!state || !client || Object.values(callbacks).some((callback) => typeof callback !== 'function')) {
    throw new TypeError('OCR workflow controller requires state, client, and callbacks.');
  }

  const clearOcrLayoutSelection = () => {
    state.ocrLayoutResult = null;
    state.selectedOcrRecordIndex = null;
    state.selectedOcrTableCandidate = null;
  };
  const zones = createOcrZoneController({ state, clearSelection: clearOcrLayoutSelection });
  const evidence = createOcrEvidenceExporter({
    state, triggerDownload, showError, decodeBase64, cryptoApi,
  });
  const dependencies = {
    state, client, ...callbacks, clearOcrLayoutSelection, navigatorApi, FileCtor,
  };
  const clipboardCapture = createClipboardCaptureOperations(dependencies);
  const batchSelection = createOcrBatchSelectionOperations({
    state, removeHostDocument, render, showError, maxBatchRequests: OCR_LIMITS.maxBatchRequests,
  });
  const searchableCopy = createSearchableCopyOperations({ ...dependencies, cryptoApi });
  const batchProcessing = createOcrBatchProcessingOperations({
    ...dependencies, maxBatchRequests: OCR_LIMITS.maxBatchRequests,
  });
  const batchDownload = createOcrBatchDownloadOperations(dependencies);
  const pageAnalysis = createOcrPageAnalysisOperations({
    ...dependencies, normalizedCurrentPageOcrZones: zones.normalizedCurrentPageOcrZones,
  });
  const suspectReview = createOcrSuspectReviewOperations({
    ...dependencies, BlobConstructor,
  });

  return Object.freeze({
    currentPageOcrZones: zones.currentPageOcrZones,
    clearOcrLayoutSelection,
    newOcrZone: zones.newOcrZone,
    updateSelectedOcrZone: zones.updateSelectedOcrZone,
    removeSelectedOcrZone: zones.removeSelectedOcrZone,
    normalizedCurrentPageOcrZones: zones.normalizedCurrentPageOcrZones,
    setOcrBatchFiles: batchSelection.setOcrBatchFiles,
    createClipboardScreenshotOcr: clipboardCapture.createClipboardScreenshotOcr,
    createSearchableOcrCopy: searchableCopy.createSearchableOcrCopy,
    runOcrBatch: batchProcessing.runOcrBatch,
    downloadOcrBatchArtifact: batchDownload.downloadOcrBatchArtifact,
    exportOcrBatchManifest: batchDownload.exportOcrBatchManifest,
    analyzeSelectedPageOcr: pageAnalysis.analyzeSelectedPageOcr,
    exportOcrLayout: evidence.exportOcrLayout,
    setOcrSuspectReviewState: suspectReview.setOcrSuspectReviewState,
    exportOcrSuspectReview: suspectReview.exportOcrSuspectReview,
  });
}
