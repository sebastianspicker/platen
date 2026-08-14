import { MAX_BROWSER_VERIFIED_OCR_BYTES, verifyOcrArtifactBlob } from './ocr-artifact-verification.js';
import {
  assertClipboardPngBlob,
  assertSingleClipboardPngItem,
} from '../../core/clipboard-image-contract.js';

function normalizeUserDictionary(state) {
  return state.ocrUserDictionary.split(/\r?\n/u).filter((term) => term.trim());
}

function documentStem(document = {}) {
  return (document.name || 'document').replace(/\.pdf$/i, '');
}

export function createClipboardCaptureOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  triggerDownload,
  render,
  removeHostDocument,
  cryptoApi,
  navigatorApi = globalThis.navigator,
  FileCtor = globalThis.File,
}) {
  async function createClipboardScreenshotOcr() {
    if (!state.analysis.documentId || !state.ocrLanguages.includes(state.ocrLanguage) || state.busyAction) return;
    const operation = captureOperation();
    const language = state.ocrLanguage;
    const options = {
      language,
      cleanupPreset: state.ocrCleanupPreset,
      segmentation: state.ocrSegmentation,
      userDictionary: normalizeUserDictionary(state),
    };
    state.busyAction = 'Converting clipboard PNG and running OCR…';
    state.error = null;
    render();

    const fileName = `${documentStem(state.document)}-clipboard-ocr-input.png`;
    let input = null;
    let temporaryPdf = null;
    let ocrArtifact = null;
    let pendingDownload = null;
    let operationError = null;
    const collectError = (error) => {
      if (!error) return;
      operationError = operationError ? new AggregateError([operationError, error], 'Clipboard screenshot OCR and cleanup completed with multiple errors.') : error;
    };
    try {
      if (!navigatorApi?.clipboard || typeof navigatorApi.clipboard.read !== 'function') {
        throw new Error('Clipboard image reading is unavailable in this browser.');
      }
      const items = await navigatorApi.clipboard.read();
      if (!operationIsCurrent(operation)) return;
      const item = assertSingleClipboardPngItem(items, 'Clipboard image OCR');
      const screenshotBlob = await item.getType('image/png');
      if (!operationIsCurrent(operation)) return;
      assertClipboardPngBlob(screenshotBlob, {
        label: 'Clipboard image OCR',
        BlobCtor: Blob,
      });
      if (typeof FileCtor !== 'function') {
        throw new Error('The browser cannot create local input assets for clipboard OCR.');
      }
      input = await client.uploadInput(new FileCtor([screenshotBlob], fileName, {
        type: 'image/png',
      }), { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      temporaryPdf = await client.convertInput(input.id, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      if (temporaryPdf?.operation?.validation?.pageCount !== 1) {
        const error = new Error('Clipboard image conversion must produce exactly one PDF page.');
        error.code = 'INVALID_CLIPBOARD_CONVERSION';
        throw error;
      }
      const result = await client.ocrDocument(temporaryPdf.id, options, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      ocrArtifact = result.artifact;
      if (ocrArtifact?.documentId !== temporaryPdf.id || result.sourceDigest !== temporaryPdf.sha256) {
        const error = new Error('The clipboard OCR result is not bound to the temporary conversion output.');
        error.code = 'INVALID_CLIPBOARD_OCR_BINDING';
        throw error;
      }
      if (ocrArtifact.size > MAX_BROWSER_VERIFIED_OCR_BYTES) {
        throw new Error('The browser-verified OCR workflow is limited to 64 MiB artifacts.');
      }
      const blob = await client.artifact(result.artifact.id, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      const verified = await verifyOcrArtifactBlob(result.artifact, blob, { cryptoApi });
      if (!operationIsCurrent(operation)) return;
      pendingDownload = {
        blob: verified,
        fileName: `${documentStem(state.document)}-clipboard-screenshot-searchable-ocr.pdf`,
        message: 'Clipboard screenshot searchable OCR PDF is ready as a separate file. The source PDF is unchanged.',
      };
    } catch (error) {
      collectError(error);
    } finally {
      const cleanup = [];
      if (ocrArtifact?.id) cleanup.push(() => client.deleteArtifact(ocrArtifact.id));
      if (temporaryPdf?.id) cleanup.push(() => removeHostDocument(temporaryPdf.id));
      if (input?.id) cleanup.push(() => client.deleteInput(input.id));
      const cleanupOutcomes = await Promise.allSettled(cleanup.map((task) => task()));
      const cleanupErrors = cleanupOutcomes
        .filter((outcome) => outcome.status === 'rejected')
        .map((outcome) => outcome.reason);
      cleanupErrors.forEach(collectError);
      if (!operationError && pendingDownload && operationIsCurrent(operation)) {
        triggerDownload(pendingDownload);
      }
      if (operationError && operationIsCurrent(operation)) {
        reportOperationError(operationError, operation);
      }
      finishOperation(operation);
    }
  }

  return Object.freeze({ createClipboardScreenshotOcr });
}
