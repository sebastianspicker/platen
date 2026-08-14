function createOcrActions({ controllers: { ocr }, render, showError }) {
  return {
    'create-ocr-copy': ocr.createSearchableOcrCopy,
    'ocr-screenshot-capture': ocr.createClipboardScreenshotOcr,
    'add-ocr-zone': () => {
      try {
        ocr.newOcrZone();
        render();
      } catch (error) {
        showError(error);
      }
    },
    'remove-ocr-zone': () => { ocr.removeSelectedOcrZone(); render(); },
    'analyze-ocr-page': ocr.analyzeSelectedPageOcr,
    'export-ocr-layout-json': () => ocr.exportOcrLayout('json'),
    'export-ocr-layout-html': () => ocr.exportOcrLayout('html'),
    'export-ocr-layout-alto': () => ocr.exportOcrLayout('alto'),
    'export-ocr-table-csv': () => ocr.exportOcrLayout('table-csv'),
    'run-ocr-batch': ocr.runOcrBatch,
    'download-ocr-batch-artifact': (actionElement) => ocr.downloadOcrBatchArtifact(
      actionElement.dataset.ocrBatchId,
    ),
    'export-ocr-batch-manifest': ocr.exportOcrBatchManifest,
    'export-ocr-suspect-review': ocr.exportOcrSuspectReview,
  };
}

function createPrepressActions({ state, controllers: { review } }) {
  return {
    'prepress-ink-coverage': () => review.runPrepress('ink-coverage'),
    'prepress-run-profile': () => review.runPrepress('preflight'),
    'prepress-separations': () => review.runPrepress('separations'),
    'prepress-overprint': () => review.runPrepress('overprint-preview'),
    'prepress-convert-cmyk': () => review.runPrepressArtifact('icc-convert'),
    'prepress-impose-2up': () => review.runPrepressArtifact(
      'imposition',
      { layout: '2x1', marks: state.impositionMarks },
    ),
    'prepress-impose-4up': () => review.runPrepressArtifact(
      'imposition',
      { layout: '2x2', marks: state.impositionMarks },
    ),
    'prepress-production-validation': review.runProductionValidation,
    'prepress-assign-output-intent': review.assignOutputIntent,
    'export-preflight-json': review.exportPreflightReport,
  };
}

function createValidationActions({ controllers: { review } }) {
  return {
    'run-standards-validation': review.runStandardsValidation,
    'export-standards-validation': review.exportStandardsValidation,
    'run-accessibility-review': review.runAccessibilityReview,
    'export-accessibility-review': review.exportAccessibilityReview,
    'create-accessibility-proposal': review.createAccessibilityProposal,
    'create-accessibility-alt-text-proposal': review.createAccessibilityAltTextProposal,
    'create-accessibility-language-title-copy': review.runIncrementalAccessibilityMetadata,
  };
}

export function createApplicationReviewActions(context) {
  return {
    ...createOcrActions(context),
    ...createPrepressActions(context),
    ...createValidationActions(context),
  };
}
