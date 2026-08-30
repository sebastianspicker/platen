import { MAX_BROWSER_VERIFIED_OCR_BYTES, verifyOcrArtifactBlob } from './ocr-artifact-verification.js';

export function createSearchableCopyOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  triggerDownload,
  render,
  cryptoApi,
}) {
  async function createSearchableOcrCopy() {
    if (!state.analysis.documentId || !state.ocrLanguages.includes(state.ocrLanguage)
      || state.busyAction) return;
    const operation = captureOperation();
    const language = state.ocrLanguage;
    state.busyAction = `Creating ${language} searchable OCR copy…`;
    state.error = null;
    state.ocrResult = null;
    state.ocrSuspectReviewStates = [];
    render();
    try {
      const { artifact, result, sourceDigest } = await client.ocrDocument(operation.documentId, {
        language,
        cleanupPreset: state.ocrCleanupPreset,
        segmentation: state.ocrSegmentation,
        userDictionary: state.ocrUserDictionary.split(/\r?\n/u).filter((term) => term.trim()),
      }, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      if (artifact.documentId !== operation.documentId || sourceDigest !== state.analysis.sha256) {
        throw new Error('The local OCR result is not bound to the current source document.');
      }
      if (artifact.size > MAX_BROWSER_VERIFIED_OCR_BYTES) {
        await client.deleteArtifact(artifact.id);
        throw new Error('The browser-verified OCR workflow is limited to 64 MiB artifacts.');
      }
      const downloaded = await client.artifact(artifact.id, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      const blob = await verifyOcrArtifactBlob(artifact, downloaded, { cryptoApi });
      if (!operationIsCurrent(operation)) return;
      state.ocrResult = Object.freeze({
        ...result,
        sourceDigest,
        artifact: Object.freeze({ id: artifact.id, sha256: artifact.sha256 }),
      });
      state.ocrSuspectReviewStates = result.suspects.map(() => 'unreviewed');
      triggerDownload({
        blob,
        fileName: artifact.displayName,
        message: `Searchable OCR copy created locally. It is rasterized; ${result.suspects.length} low-confidence word${result.suspects.length === 1 ? '' : 's'} flagged.`,
      });
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  return { createSearchableOcrCopy };
}
