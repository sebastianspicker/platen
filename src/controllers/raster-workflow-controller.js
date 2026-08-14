import { normalizedRectangle } from '../core/normalized-rectangle.js';
import { createJsonDownload } from './review/json-download.js';
import { createRedactionPlanOperations } from './raster-workflow/redaction-plan-operations.js';

function createRasterParameters(state) {
  return function rasterParameters(operation) {
    const page = state.selectedPage;
    if (operation === 'rotate') return { pages: [page], degrees: 90 };
    if (operation === 'crop') {
      return { pages: [page], region: normalizedRectangle(state.cropRegion, 'Crop') };
    }
    if (operation === 'resize') {
      const widthPoints = Number(state.resizeWidth);
      const heightPoints = Number(state.resizeHeight);
      if (!Number.isSafeInteger(widthPoints) || !Number.isSafeInteger(heightPoints)
        || widthPoints < 64 || widthPoints > 2048
        || heightPoints < 64 || heightPoints > 2048) {
        throw new Error('Resize dimensions must be whole points from 64 through 2048.');
      }
      return { pages: [page], widthPoints, heightPoints };
    }
    if (operation === 'overlay') {
      const text = state.overlayText.trim();
      if (!text) throw new Error('Overlay text is required.');
      return {
        overlay: {
          placement: state.overlayPlacement,
          text,
          pointSize: state.overlayPlacement === 'watermark' ? 36 : 14,
        },
      };
    }
    if (operation === 'redact') {
      const removedText = state.redactionText.trim();
      if (!removedText) {
        throw new Error('Enter the exact source text that the redaction must remove.');
      }
      return {
        profile: 'verified-raster-burn-v2',
        sourceSha256: state.analysis.sha256,
        pages: [page],
        redactions: [state.redactionFullPage
          ? { page, fullPage: true, removedText }
          : {
            page,
            region: normalizedRectangle(state.redactionRegion, 'Redaction'),
            removedText,
          }],
      };
    }
    if (operation === 'flatten') return {};
    throw new Error('Unknown raster editing operation.');
  };
}

export function createRasterWorkflowController({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  downloadDerivedArtifact,
  render,
  showError,
  announce = () => {},
  confirm = globalThis.window?.confirm?.bind(globalThis.window) ?? (() => false),
  triggerDownload,
  Blob: BlobConstructor = Blob,
  JSON: json = JSON,
}) {
  const callbacks = {
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    downloadDerivedArtifact,
    render,
    showError,
    announce,
    confirm,
    triggerDownload,
  };
  if (!state || !client || Object.values(callbacks).some((callback) => typeof callback !== 'function')) {
    throw new TypeError('Raster workflow controller requires state, client, and callbacks.');
  }

  const rasterParameters = createRasterParameters(state);
  const jsonDownload = createJsonDownload({ triggerDownload, BlobConstructor, json });
  const redactionPlans = createRedactionPlanOperations({
    state,
    client,
    jsonDownload,
    ...callbacks,
  });

  async function runRasterMutation(operationName) {
    if (!state.analysis.documentId || state.busyAction) return;
    let parameters;
    try {
      parameters = rasterParameters(operationName);
    } catch (error) {
      showError(error);
      return;
    }
    const operation = captureOperation();
    const labels = {
      rotate: 'Rotating the selected page in a raster-derived PDF…',
      crop: 'Cropping the selected page in a raster-derived PDF…',
      resize: 'Resizing the selected page in a raster-derived PDF…',
      overlay: 'Adding recurring text to a raster-derived PDF…',
      redact: 'Applying and validating a verified raster-burn redaction…',
      flatten: 'Flattening all pages into a raster-derived PDF…',
    };
    if (operationName === 'redact') state.redactionText = '';
    state.busyAction = labels[operationName] ?? 'Creating a raster-derived PDF…';
    state.error = null;
    render();
    try {
      const request = client.mutateRaster(
        operation.documentId,
        operationName,
        parameters,
        { signal: operation.controller.signal },
      );
      if (operationName === 'redact') {
        for (const redaction of parameters.redactions ?? []) redaction.removedText = '';
      }
      const artifact = await request;
      if (!operationIsCurrent(operation)) return;
      await downloadDerivedArtifact(
        artifact,
        operation,
        `${artifact.displayName} created and validated. The immutable source is unchanged; vectors, forms, links, tags, layers, and signatures are not preserved.`,
      );
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      if (operationName === 'redact') {
        for (const redaction of parameters.redactions ?? []) redaction.removedText = '';
      }
      finishOperation(operation);
    }
  }

  async function runFullPageRedaction() {
    if (!state.analysis.documentId || state.busyAction || state.host?.fullPageRedactionReady !== true) return;
    if (!confirm('Create a separate closed PDF with the selected page fully redacted at the PDF object level? The strict profile removes the target page content and reachable resources from the closed output, preserves non-target text and renders, and does not support region redaction or claim whole-document sanitization. The source remains unchanged.')) return;
    const operation = captureOperation();
    state.busyAction = 'Creating and independently validating an object-level full-page redaction copy…'; state.error = null; render();
    try {
      const result = await client.runFullPageRedaction(operation.documentId, state.analysis.sha256, { page: state.selectedPage }, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      state.fullPageRedactionResult = result;
      await downloadDerivedArtifact(result.artifact, operation, `${result.artifact.displayName} created with the selected page fully redacted at object level. The immutable source is unchanged.`);
    } catch (error) { reportOperationError(error, operation); } finally { finishOperation(operation); }
  }

  return Object.freeze({ rasterParameters, runRasterMutation, runFullPageRedaction, ...redactionPlans });
}
