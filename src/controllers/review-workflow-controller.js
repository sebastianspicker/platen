import { createAccessibilityReviewOperations } from './review/accessibility-review-operations.js';
import { createAccessibilityAltTextOperations } from './review/accessibility-alt-text-operations.js';
import { createAccessibilityMetadataOperations } from './review/accessibility-metadata-operations.js';
import { createJsonDownload } from './review/json-download.js';
import { createPrepressOperations } from './review/prepress-operations.js';
import { createStandardsValidationOperations } from './review/standards-validation-operations.js';

export function createReviewWorkflowController({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  downloadDerivedArtifact,
  downloadEphemeralDerivedArtifact,
  triggerDownload,
  render,
  announce,
  showError,
  confirm = globalThis.window?.confirm?.bind(globalThis.window) ?? (() => false),
  Blob: BlobConstructor = Blob,
  JSON: json = JSON,
}) {
  const callbacks = {
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    downloadDerivedArtifact,
    downloadEphemeralDerivedArtifact,
    triggerDownload,
    render,
    announce,
    showError,
    confirm,
  };
  if (!state || !client || Object.values(callbacks).some((callback) => typeof callback !== 'function')) {
    throw new TypeError('Review workflow controller requires state, client, and workflow callbacks.');
  }

  const jsonDownload = createJsonDownload({ triggerDownload, BlobConstructor, json });
  const dependencies = { state, client, BlobConstructor, jsonDownload, ...callbacks };
  const prepress = createPrepressOperations(dependencies);
  const standards = createStandardsValidationOperations(dependencies);
  const accessibility = createAccessibilityReviewOperations(dependencies);
  const accessibilityAltText = createAccessibilityAltTextOperations(dependencies);
  const accessibilityMetadata = createAccessibilityMetadataOperations(dependencies);

  return Object.freeze({
    runPrepress: prepress.runPrepress,
    runPrepressArtifact: prepress.runPrepressArtifact,
    runProductionValidation: prepress.runProductionValidation,
    assignOutputIntent: prepress.assignOutputIntent,
    exportPreflightReport: prepress.exportPreflightReport,
    runStandardsValidation: standards.runStandardsValidation,
    exportStandardsValidation: standards.exportStandardsValidation,
    runAccessibilityReview: accessibility.runAccessibilityReview,
    exportAccessibilityReview: accessibility.exportAccessibilityReview,
    createAccessibilityProposal: accessibility.createAccessibilityProposal,
    createAccessibilityAltTextProposal: accessibilityAltText.createAccessibilityAltTextProposal,
    runIncrementalAccessibilityMetadata: accessibilityMetadata.runIncrementalAccessibilityMetadata,
  });
}
