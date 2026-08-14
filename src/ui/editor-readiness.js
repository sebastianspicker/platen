import { freezeEditorReadiness } from './editor-readiness-freeze.js';
import {
  pdfKitLocalGoToRemovalCandidates,
  pdfKitOutlineRemovalCandidates,
  pdfKitOutlineRenameCandidates,
} from '../core/pdfkit-workflow-contract.js';
import { validIncrementalBleedBoxRequest } from '../core/pdf-incremental-bleed-box-contract.js';
import {
  incrementalGoToLinkRequestFitsInspectedCropBox,
  validIncrementalGoToLinkRequest,
} from '../core/pdf-incremental-goto-link-contract.js';
import { validIncrementalMetadata } from '../core/pdf-incremental-metadata-contract.js';
import { validIncrementalPageVectorRequest } from '../core/pdf-incremental-page-vector-contract.js';
import { validPageTextRequest } from '../core/pdf-page-text-contract.js';
import { validFullPageRedactionRequest } from '../core/pdf-full-page-redaction-contract.js';
import { validPdfKitOutlineLabel } from '../core/pdfkit-outline-label.js';
import {
  countOutlineItems,
  incrementalBleedBoxRequestFromState,
  incrementalGoToLinkRequestFromState,
  incrementalPageVectorRequestFromState,
  javascriptRemovalSourceReady,
  pageTextRequestFromState,
  passiveIncrementalSourceReady,
  safeRewriteSourceReady,
  selectedPageBoxReadiness,
} from './editor-readiness-helpers.js';
import {
  accessibilityAltTextReadiness,
  annotationFlattenReadiness,
  incrementalAccessibilityMetadataReadiness,
  incrementalNamedDestinationReadiness,
} from './editor-readiness-specialized.js';

function deriveEditorReadinessSnapshot(state, analysis) {
  const info = analysis.inspection; const structure = analysis.structure; const engines = state.host?.engines ?? [];
  const isEngineAvailable = (name) => engines.some((engine) => engine.name === name && engine.available);
  const ready = analysis.status === 'ready' && !state.busyAction;
  const mutationReady = ready && state.host?.pdfkitMutationReady
    && state.pdfkitInspectionResult?.sourceDigest === analysis.sha256;
  const selection = derivePdfKitSelection(state, analysis, info, mutationReady);
  const unsigned = analysis.signatures?.status === 'unsigned' && analysis.signatures?.signatureCount === 0;
  const passiveIncrementalSource = passiveIncrementalSourceReady({
    ready, unsigned, info, formKind: selection.formKind, analysis, structure,
  });
  return {
    info, structure, isEngineAvailable, ready, mutationReady, unsigned, passiveIncrementalSource,
    ...selection,
  };
}

function derivePdfKitSelection(state, analysis, info, mutationReady) {
  const formKind = String(info?.form ?? 'unknown').toLowerCase();
  const legacyReady = mutationReady && formKind === 'none';
  const binding = derivePdfKitBinding(state, analysis, formKind, legacyReady);
  const pageReadiness = derivePdfKitPageReadiness(state, binding.page, binding.boundPdfKitInspection, legacyReady);
  return { formKind, legacyReady, ...binding, ...pageReadiness };
}

function derivePdfKitBinding(state, analysis, formKind, legacyReady) {
  const boundPdfKitInspection = state.pdfkitInspectionResult?.sourceDigest === analysis.sha256 ? state.pdfkitInspectionResult : null;
  const page = boundPdfKitInspection?.pages?.find(({ index }) => index === (state.selectedPage ?? 1));
  const widgets = (page?.widgets ?? []).filter((widget) => ['text', 'choice'].includes(widget.fieldType)
    || (widget.fieldType === 'button' && ['checkbox', 'radio'].includes(widget.controlKind)));
  const selectedWidget = widgets.find(({ annotationIndex }) => String(annotationIndex) === String(state.pdfkitWidgetIndex));
  const existingAnnotations = (page?.annotations ?? []).filter(({ subtype }) => ['freeText', 'square', 'circle', 'highlight'].includes(subtype));
  return {
    boundPdfKitInspection, page, selectedWidget, existingAnnotations,
  };
}

function derivePdfKitPageReadiness(state, page, boundPdfKitInspection, legacyReady) {
  const pageCount = state.pdfkitInspectionResult?.pageCount;
  const boundedPageCount = Number.isSafeInteger(pageCount) && pageCount >= 1 && pageCount <= 100 ? pageCount : 0;
  const localLinkReady = legacyReady && boundedPageCount >= 1
    && page?.annotationsTruncated === false && (page?.annotations?.length ?? 50) < 50;
  const requestedRotation = Number(state.pdfkitPageRotation);
  const currentRotation = [0, 90, 180, 270].includes(page?.rotation) ? page.rotation : null;
  const pageBoxReadiness = selectedPageBoxReadiness(state, page);
  return {
    pageCount, boundedPageCount, localLinkReady, requestedRotation, currentRotation,
    pageBoxReadiness,
  };
}

function deriveIncrementalReadiness(state, analysis, snapshot) {
  const incrementalMetadataReady = deriveIncrementalMetadataReadiness(state, snapshot);
  const incrementalBleedBoxReady = deriveIncrementalBleedBoxReadiness(state, snapshot);
  const goToLinkReadiness = deriveIncrementalGoToLinkReadiness(state, snapshot);
  const namedDestinationReadiness = incrementalNamedDestinationReadiness({
    state, passive: snapshot.passiveIncrementalSource, structure: snapshot.structure,
    pageCount: snapshot.info?.pageCount,
  });
  const accessibilityMetadataReadiness = incrementalAccessibilityMetadataReadiness({
    state, analysis, passive: snapshot.passiveIncrementalSource,
  });
  const pageContentReadiness = deriveIncrementalPageContentReadiness(state, snapshot);
  const fullPageRedactionReady = deriveFullPageRedactionReadiness(state, snapshot);
  return {
    incrementalMetadataReady, incrementalBleedBoxReady,
    ...goToLinkReadiness, namedDestinationReadiness, accessibilityMetadataReadiness,
    ...pageContentReadiness, fullPageRedactionReady,
  };
}

function deriveIncrementalMetadataReadiness(state, snapshot) {
  const { info, passiveIncrementalSource } = snapshot;
  const requestedMetadata = Object.fromEntries(
    ['title', 'author', 'subject', 'keywords'].map((key) => {
      const value = String(state.pdfkitMetadata?.[key] ?? ''); return [key, value === '' ? null : value];
    }),
  );
  const incrementalMetadataChanged = Object.entries(requestedMetadata).some(
    ([key, value]) => value !== (typeof info?.[key] === 'string' && info[key] !== '' ? info[key] : null),
  );
  const incrementalMetadataReady = passiveIncrementalSource
    && state.host?.incrementalMetadataReady === true
    && validIncrementalMetadata(requestedMetadata) && incrementalMetadataChanged;
  return incrementalMetadataReady;
}

function deriveIncrementalBleedBoxReadiness(state, snapshot) {
  const { page, pageBoxReadiness, passiveIncrementalSource } = snapshot;
  const incrementalBleedBoxRequest = incrementalBleedBoxRequestFromState(state);
  const incrementalBleedBoxReady = passiveIncrementalSource
    && state.host?.incrementalBleedBoxReady === true
    && state.pdfkitPageBox === 'bleed'
    && validIncrementalBleedBoxRequest(incrementalBleedBoxRequest)
    && (!page || (pageBoxReadiness.geometryReady && pageBoxReadiness.changed));
  return incrementalBleedBoxReady;
}

function deriveIncrementalGoToLinkReadiness(state, snapshot) {
  const { info, passiveIncrementalSource } = snapshot;
  const incrementalGoToLinkRequest = incrementalGoToLinkRequestFromState(state);
  const incrementalGoToLinkEditorReady = passiveIncrementalSource
    && state.host?.incrementalGoToLinkReady === true;
  const incrementalGoToLinkReady = incrementalGoToLinkEditorReady
    && validIncrementalGoToLinkRequest(incrementalGoToLinkRequest) && incrementalGoToLinkRequestFitsInspectedCropBox(state, incrementalGoToLinkRequest)
    && incrementalGoToLinkRequest.sourcePage <= info.pageCount
    && incrementalGoToLinkRequest.targetPage <= info.pageCount;
  return { incrementalGoToLinkReady, incrementalGoToLinkEditorReady };
}

function deriveIncrementalPageContentReadiness(state, snapshot) {
  const { info, passiveIncrementalSource } = snapshot;
  const incrementalPageVectorRequest = incrementalPageVectorRequestFromState(state);
  const incrementalPageVectorEditorReady = passiveIncrementalSource
    && state.host?.incrementalPageVectorReady === true;
  const incrementalPageVectorReady = incrementalPageVectorEditorReady
    && validIncrementalPageVectorRequest(incrementalPageVectorRequest)
    && incrementalPageVectorRequest.page <= info.pageCount;
  const pageTextRequest = pageTextRequestFromState(state);
  const pageTextEditorReady = passiveIncrementalSource
    && state.host?.pageTextReady === true;
  const pageTextReady = pageTextEditorReady
    && validPageTextRequest(pageTextRequest)
    && pageTextRequest.page <= info.pageCount;
  return {
    incrementalPageVectorReady, incrementalPageVectorEditorReady,
    pageTextReady, pageTextEditorReady,
  };
}

function deriveFullPageRedactionReadiness(state, snapshot) {
  const { info, passiveIncrementalSource } = snapshot;
  const fullPageRedactionRequest = { page: Number(state.selectedPage) };
  const fullPageRedactionReady = passiveIncrementalSource
    && state.host?.fullPageRedactionReady === true
    && validFullPageRedactionRequest(fullPageRedactionRequest)
    && fullPageRedactionRequest.page <= info.pageCount;
  return fullPageRedactionReady;
}

function deriveEditorReadinessContext(state, analysis, snapshot) {
  const {
    info, structure, ready, unsigned, formKind, boundPdfKitInspection, page,
    pageCount, legacyReady,
  } = snapshot;
  const altTextReadiness = accessibilityAltTextReadiness({ state, analysis, ready });
  const outlineContext = { state, page, pageCount, legacyReady, unsigned };
  const outlineReadiness = deriveOutlineReadiness(outlineContext);
  const rewriteReadiness = deriveRewriteReadiness(state, analysis, snapshot);
  const snapshotCapture = deriveSnapshotCapture(state);
  const rasterAvailable = snapshot.isEngineAvailable('magick');
  const ocrLanguages = Object.freeze([...(state.ocrLanguages ?? [])]);
  const protectedArtifact = state.pdfkitProtectionResult?.artifact;
  return {
    altTextReadiness, ...outlineReadiness, ...rewriteReadiness, ...snapshotCapture,
    rasterAvailable, ocrLanguages, protectedArtifact,
  };
}

function deriveOutlineReadiness(outlineContext) {
  const localGoToRemovalReady = deriveLocalGoToRemovalReadiness(outlineContext);
  const outlineRemoval = deriveOutlineRemovalReadiness(outlineContext);
  const outlineRenameReady = deriveOutlineRenameReadiness(outlineContext, outlineRemoval.outline);
  return { localGoToRemovalReady, ...outlineRemoval, outlineRenameReady };
}

function deriveLocalGoToRemovalReadiness(outlineContext) {
  const {
    state, page, pageCount, legacyReady, unsigned,
  } = outlineContext;
  const localGoToRemovalCandidates = pdfKitLocalGoToRemovalCandidates(page, pageCount);
  const localGoToRemovalReady = legacyReady && unsigned
    && localGoToRemovalCandidates.some(({ annotationIndex }) => (
      String(annotationIndex) === String(state.pdfkitLocalLinkRemovalIndex)
    ));
  return localGoToRemovalReady;
}

function deriveOutlineRemovalReadiness(outlineContext) {
  const { state, legacyReady, unsigned } = outlineContext;
  const outline = state.pdfkitInspectionResult?.outline;
  const outlineCount = countOutlineItems(outline?.items);
  const outlineRemovalCandidates = pdfKitOutlineRemovalCandidates(outline);
  const outlineRemovalReady = legacyReady && unsigned
    && outlineRemovalCandidates.some(({ topLevelIndex }) => (
      String(topLevelIndex) === String(state.pdfkitOutlineRemovalIndex)
    ));
  return { outline, outlineCount, outlineRemovalReady };
}

function deriveOutlineRenameReadiness(outlineContext, outline) {
  const { state, legacyReady, unsigned } = outlineContext;
  const outlineRenameCandidates = pdfKitOutlineRenameCandidates(outline);
  const selectedRename = outlineRenameCandidates.find(({ topLevelIndex }) => (
    String(topLevelIndex) === String(state.pdfkitOutlineRenameIndex)
  ));
  const outlineRenameReady = legacyReady && unsigned && Boolean(selectedRename)
    && validPdfKitOutlineLabel(state.pdfkitOutlineRenameLabel) && state.pdfkitOutlineRenameLabel !== selectedRename.title;
  return outlineRenameReady;
}

function deriveRewriteReadiness(state, analysis, snapshot) {
  const {
    info, structure, ready, unsigned, formKind, boundPdfKitInspection, page,
  } = snapshot;
  const safeRewriteSource = safeRewriteSourceReady({ ready, unsigned, info, formKind, analysis, structure });
  const annotationFlattenReady = annotationFlattenReadiness({
    state, ready, unsigned, info, formKind, analysis, structure,
    inspection: boundPdfKitInspection, page,
  });
  const javascriptRemovalReady = javascriptRemovalSourceReady({ state, ready, unsigned, info, formKind, analysis, structure });
  return { safeRewriteSource, annotationFlattenReady, javascriptRemovalReady };
}

function deriveSnapshotCapture(state) {
  const snapshot = deriveSnapshotRequest(state);
  const snapshotGeometryReady = validSnapshotGeometry(snapshot.snapshotRegion);
  return {
    snapshotGeometryReady, ...snapshot,
  };
}

function deriveSnapshotRequest(state) {
  const snapshotRegion = Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number(state.snapshotRegion?.[key] ?? ({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 })[key])]));
  const snapshotDpi = Number(state.snapshotDpi ?? 192);
  return { snapshotRegion, snapshotDpi };
}

function validSnapshotGeometry(snapshotRegion) {
  return validSnapshotValues(snapshotRegion)
    && validSnapshotOrigin(snapshotRegion)
    && validSnapshotExtent(snapshotRegion);
}

function validSnapshotValues(snapshotRegion) {
  return Object.values(snapshotRegion).every((value) => Number.isFinite(value) && Number(value.toFixed(6)) === value);
}

function validSnapshotOrigin(snapshotRegion) {
  return snapshotRegion.x >= 0 && snapshotRegion.y >= 0
    && snapshotRegion.x < 1 && snapshotRegion.y < 1;
}

function validSnapshotExtent(snapshotRegion) {
  return snapshotRegion.width > 0 && snapshotRegion.height > 0
    && snapshotRegion.x + snapshotRegion.width <= 1 && snapshotRegion.y + snapshotRegion.height <= 1;
}

/**
 * Derives all inspector action gates from one immutable snapshot of editor state.
 * Rendering modules consume this value only; they never recalculate availability.
 */
export function deriveEditorReadiness(state, analysis) {
  const snapshot = deriveEditorReadinessSnapshot(state, analysis);
  const incremental = deriveIncrementalReadiness(state, analysis, snapshot);
  const context = deriveEditorReadinessContext(state, analysis, snapshot);
  return freezeEditorReadiness({
    state, analysis, ...snapshot, ...incremental, ...context,
  });
}
