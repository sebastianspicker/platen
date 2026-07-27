import {
  canonicalOcrSuspectReviewJson,
  createOcrSuspectReviewExport,
  ocrSuspectDigest,
} from '../../core/ocr-suspect-review-contract.js';

const REVIEW_STATES = new Set([
  'unreviewed',
  'confirmed-low-confidence',
  'false-positive',
]);

function exportInput(result, reviewDecisions) {
  return {
    sourceDigest: result.sourceDigest,
    artifact: result.artifact,
    ocr: {
      language: result.language,
      cleanupPreset: result.cleanupPreset,
      segmentation: result.segmentation,
      pageCount: result.pageCount,
      suspects: result.suspects,
    },
    reviewDecisions,
  };
}

export function createOcrSuspectReviewOperations({
  state,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  BlobConstructor,
  triggerDownload,
  render,
  announce,
}) {
  function setOcrSuspectReviewState(index, reviewState) {
    if (state.busyAction || !Number.isSafeInteger(index) || index < 0
      || index >= (state.ocrResult?.suspects?.length ?? 0)
      || !REVIEW_STATES.has(reviewState)) return false;
    state.ocrSuspectReviewStates[index] = reviewState;
    return true;
  }

  async function exportOcrSuspectReview() {
    const result = state.ocrResult;
    const reviewStates = [...state.ocrSuspectReviewStates];
    if (state.busyAction || !result?.sourceDigest || !result?.artifact
      || !Array.isArray(result.suspects) || reviewStates.length !== result.suspects.length) return;
    const operation = captureOperation();
    state.busyAction = 'Preparing the source-bound OCR suspect review report…';
    state.error = null;
    render();
    try {
      const digests = await Promise.all(result.suspects.map(ocrSuspectDigest));
      const reviewDecisions = Object.fromEntries(
        digests.map((digest, index) => [digest, reviewStates[index]]),
      );
      const report = await createOcrSuspectReviewExport(exportInput(result, reviewDecisions));
      if (!operationIsCurrent(operation) || state.ocrResult !== result) return;
      const decisionsAreCurrent = reviewStates.length === state.ocrSuspectReviewStates.length
        && reviewStates.every((reviewState, index) => (
          reviewState === state.ocrSuspectReviewStates[index]
        ));
      if (!decisionsAreCurrent) return;
      const stem = (state.document?.name || 'document').replace(/\.pdf$/iu, '');
      const canonical = canonicalOcrSuspectReviewJson(report);
      triggerDownload({
        blob: new BlobConstructor([canonical], { type: 'application/json' }),
        fileName: `${stem}-ocr-suspect-review.json`,
        message: 'Source-bound OCR suspect review exported as canonical JSON.',
      });
      announce('OCR suspect review exported. No OCR artifact or PDF bytes were changed.');
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  return Object.freeze({ setOcrSuspectReviewState, exportOcrSuspectReview });
}
