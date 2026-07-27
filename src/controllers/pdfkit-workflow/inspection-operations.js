import {
  isSupportedPdfKitFormWidget,
  pdfKitLocalGoToRemovalCandidates,
  pdfKitOutlineRemovalCandidates,
} from '../../core/pdfkit-workflow-contract.js';

export function createPdfKitInspectionOperations({
  state, client, captureOperation, operationIsCurrent, reportOperationError, finishOperation,
  render, announce, BlobConstructor, json, triggerDownload, syncLayerInspection,
}) {
  async function runPdfKitInspection() {
    if (!state.analysis.documentId || state.busyAction || !state.host?.pdfkitInspectionReady) return;
    const operation = captureOperation();
    state.busyAction = 'Running the pinned macOS PDFKit read-only inspection…';
    state.error = null;
    state.pdfkitInspectionResult = null;
    state.pdfkitLayerGroups = [];
    state.pdfkitLayerVisibility = [];
    state.pdfkitLayerInspectionDigest = null;
    state.pdfkitLayerStatus = 'idle';
    state.pdfkitLayerError = null;
    state.pdfkitLayerResult = null;
    render();
    try {
      const result = await client.runPdfKitInspection(operation.documentId, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      applyInspectionDefaults(result);
      syncLayerInspection?.(result);
      announce(`Read-only PDFKit inventory completed for ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}.`);
    } catch (error) {
      if (error?.code === 'STALE_PDFKIT_INSPECTION' || error?.code === 'INVALID_PDFKIT_LAYER_INSPECTION') {
        state.pdfkitLayerStatus = 'error';
        state.pdfkitLayerError = error.message;
      }
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  function applyInspectionDefaults(result) {
    state.pdfkitInspectionResult = result;
    state.annotationFlattenResult = null;
    state.attachmentRemovalResult = null;
    state.incrementalBleedBoxResult = null;
    state.incrementalGoToLinkResult = null;
    state.incrementalNamedDestinationResult = null;
    state.javascriptRemovalResult = null;
    state.incrementalMetadataResult = null;
    state.pdfkitMutationResult = null;
    state.pdfkitMetadata = Object.fromEntries(
      ['title', 'author', 'subject', 'keywords'].map((key) => [key, result.metadata?.[key] ?? '']),
    );
    const selected = result.pages?.find((page) => page.index === state.selectedPage) ?? result.pages?.[0];
    const firstWidget = selected?.widgets?.find(isSupportedPdfKitFormWidget);
    const annotationTypes = ['freeText', 'square', 'circle', 'highlight'];
    const annotation = selected?.annotations?.find(({ subtype }) => annotationTypes.includes(subtype));
    state.pdfkitWidgetIndex = firstWidget ? String(firstWidget.annotationIndex) : '';
    state.pdfkitExistingAnnotationIndex = annotation ? String(annotation.annotationIndex) : '';
    const localLink = pdfKitLocalGoToRemovalCandidates(selected, result.pageCount)[0];
    state.pdfkitLocalLinkRemovalIndex = localLink ? String(localLink.annotationIndex) : '';
    state.pdfkitOutlineTargetPage = String(selected?.index ?? 1);
    const removableBookmark = pdfKitOutlineRemovalCandidates(result.outline)[0];
    state.pdfkitOutlineRemovalIndex = removableBookmark
      ? String(removableBookmark.topLevelIndex) : '';
    state.pdfkitOutlineRenameIndex = removableBookmark
      && typeof removableBookmark.title === 'string'
      ? String(removableBookmark.topLevelIndex) : '';
    if ([0, 90, 180, 270].includes(selected?.rotation)) state.pdfkitPageRotation = String((selected.rotation + 90) % 360);
    setInspectionGeometry(result, selected);
  }

  function setInspectionGeometry(result, selected) {
    const crop = selected?.boxes?.crop;
    const media = selected?.boxes?.media;
    if (crop) {
      state.pdfkitPageBoxRect = { ...crop };
      state.pdfkitLinkRect = { x: crop.x + Math.min(36, Math.max(0, crop.width / 10)), y: crop.y + Math.min(36, Math.max(0, crop.height / 10)), width: Math.min(180, Math.max(1, crop.width / 2)), height: Math.min(40, Math.max(1, crop.height / 12)) };
      state.pdfkitLineStart = { x: crop.x + crop.width * 0.2, y: crop.y + crop.height * 0.25 };
      state.pdfkitLineEnd = { x: crop.x + crop.width * 0.8, y: crop.y + crop.height * 0.75 };
      state.pdfkitInkPoints = [[crop.x + crop.width * 0.2, crop.y + crop.height * 0.25], [crop.x + crop.width * 0.5, crop.y + crop.height * 0.5], [crop.x + crop.width * 0.8, crop.y + crop.height * 0.75]].map((entry) => entry.join(',')).join(';');
    }
    state.pdfkitLinkTargetPage = String(result.pageCount > (selected?.index ?? 1) ? (selected?.index ?? 1) + 1 : selected?.index ?? 1);
    if (media) {
      state.pdfkitAnnotationRect = { x: media.x + Math.min(36, Math.max(0, media.width / 10)), y: media.y + Math.min(36, Math.max(0, media.height / 10)), width: Math.min(180, Math.max(1, media.width / 2)), height: Math.min(80, Math.max(1, media.height / 5)) };
      state.pdfkitExistingAnnotationRect = { ...state.pdfkitAnnotationRect };
    }
  }

  function exportPdfKitInspection() {
    if (state.pdfkitInspectionResult?.kind !== 'pdfkit-structure-inspection') return;
    const stem = (state.document.name || 'document').replace(/\.pdf$/i, '');
    triggerDownload({ blob: new BlobConstructor([json.stringify(state.pdfkitInspectionResult, null, 2)], { type: 'application/json' }), fileName: `${stem}-macos-pdfkit-inventory.json`, message: 'Bounded read-only macOS PDFKit inventory exported as JSON.' });
  }

  return { runPdfKitInspection, exportPdfKitInspection };
}
