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
import { freezeEditorReadiness } from './editor-readiness-freeze.js';

/**
 * Derives all inspector action gates from one immutable snapshot of editor state.
 * Rendering modules consume this value only; they never recalculate availability.
 */
export function deriveEditorReadiness(state, analysis) {
  const info = analysis.inspection; const structure = analysis.structure; const engines = state.host?.engines ?? [];
  const isEngineAvailable = (name) => engines.some((engine) => engine.name === name && engine.available);
  const ready = analysis.status === 'ready' && !state.busyAction;
  const mutationReady = ready && state.host?.pdfkitMutationReady
    && state.pdfkitInspectionResult?.sourceDigest === analysis.sha256;
  const formKind = String(info?.form ?? 'unknown').toLowerCase();
  const legacyReady = mutationReady && formKind === 'none';
  const boundPdfKitInspection = state.pdfkitInspectionResult?.sourceDigest === analysis.sha256 ? state.pdfkitInspectionResult : null;
  const page = boundPdfKitInspection?.pages?.find(({ index }) => index === (state.selectedPage ?? 1));
  const widgets = (page?.widgets ?? []).filter((widget) => ['text', 'choice'].includes(widget.fieldType)
    || (widget.fieldType === 'button' && ['checkbox', 'radio'].includes(widget.controlKind)));
  const selectedWidget = widgets.find(({ annotationIndex }) => String(annotationIndex) === String(state.pdfkitWidgetIndex));
  const existingAnnotations = (page?.annotations ?? []).filter(({ subtype }) => ['freeText', 'square', 'circle', 'highlight'].includes(subtype));
  const pageCount = state.pdfkitInspectionResult?.pageCount;
  const boundedPageCount = Number.isSafeInteger(pageCount) && pageCount >= 1 && pageCount <= 100 ? pageCount : 0;
  const localLinkReady = legacyReady && boundedPageCount >= 1
    && page?.annotationsTruncated === false && (page?.annotations?.length ?? 50) < 50;
  const requestedRotation = Number(state.pdfkitPageRotation);
  const currentRotation = [0, 90, 180, 270].includes(page?.rotation) ? page.rotation : null;
  const pageBoxReadiness = selectedPageBoxReadiness(state, page);
  const unsigned = analysis.signatures?.status === 'unsigned' && analysis.signatures?.signatureCount === 0;
  const passiveIncrementalSource = passiveIncrementalSourceReady({ ready, unsigned, info, formKind, analysis, structure });
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
    && validIncrementalMetadata(requestedMetadata) && incrementalMetadataChanged
  const incrementalBleedBoxRequest = incrementalBleedBoxRequestFromState(state);
  const incrementalBleedBoxReady = passiveIncrementalSource
    && state.host?.incrementalBleedBoxReady === true
    && state.pdfkitPageBox === 'bleed'
    && validIncrementalBleedBoxRequest(incrementalBleedBoxRequest)
    && (!page || (pageBoxReadiness.geometryReady && pageBoxReadiness.changed));
  const incrementalGoToLinkRequest = incrementalGoToLinkRequestFromState(state);
  const incrementalGoToLinkEditorReady = passiveIncrementalSource
    && state.host?.incrementalGoToLinkReady === true;
  const incrementalGoToLinkReady = incrementalGoToLinkEditorReady
    && validIncrementalGoToLinkRequest(incrementalGoToLinkRequest) && incrementalGoToLinkRequestFitsInspectedCropBox(state, incrementalGoToLinkRequest)
    && incrementalGoToLinkRequest.sourcePage <= info.pageCount
    && incrementalGoToLinkRequest.targetPage <= info.pageCount;
  const namedDestinationReadiness = incrementalNamedDestinationReadiness({ state, passive: passiveIncrementalSource, structure, pageCount: info?.pageCount });
  const accessibilityMetadataReadiness = incrementalAccessibilityMetadataReadiness({ state, analysis, passive: passiveIncrementalSource });
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
  const fullPageRedactionRequest = { page: Number(state.selectedPage) };
  const fullPageRedactionReady = passiveIncrementalSource
    && state.host?.fullPageRedactionReady === true
    && validFullPageRedactionRequest(fullPageRedactionRequest)
    && fullPageRedactionRequest.page <= info.pageCount;
  const altTextReadiness = accessibilityAltTextReadiness({ state, analysis, ready });
  const localGoToRemovalCandidates = pdfKitLocalGoToRemovalCandidates(page, pageCount);
  const localGoToRemovalReady = legacyReady && unsigned
    && localGoToRemovalCandidates.some(({ annotationIndex }) => (
      String(annotationIndex) === String(state.pdfkitLocalLinkRemovalIndex)
    ));
  const outline = state.pdfkitInspectionResult?.outline;
  const outlineCount = countOutlineItems(outline?.items);
  const outlineRemovalCandidates = pdfKitOutlineRemovalCandidates(outline);
  const outlineRemovalReady = legacyReady && unsigned
    && outlineRemovalCandidates.some(({ topLevelIndex }) => (
      String(topLevelIndex) === String(state.pdfkitOutlineRemovalIndex)
    ));
  const outlineRenameCandidates = pdfKitOutlineRenameCandidates(outline);
  const selectedRename = outlineRenameCandidates.find(({ topLevelIndex }) => (
    String(topLevelIndex) === String(state.pdfkitOutlineRenameIndex)
  ));
  const outlineRenameReady = legacyReady && unsigned && Boolean(selectedRename)
    && validPdfKitOutlineLabel(state.pdfkitOutlineRenameLabel) && state.pdfkitOutlineRenameLabel !== selectedRename.title;
  const safeRewriteSource = safeRewriteSourceReady({ ready, unsigned, info, formKind, analysis, structure });
  const annotationFlattenReady = annotationFlattenReadiness({
    state, ready, unsigned, info, formKind, analysis, structure,
    inspection: boundPdfKitInspection, page,
  });
  const javascriptRemovalReady = javascriptRemovalSourceReady({ state, ready, unsigned, info, formKind, analysis, structure });
  const snapshotRegion = Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number(state.snapshotRegion?.[key] ?? ({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 })[key])]));
  const snapshotDpi = Number(state.snapshotDpi ?? 192);
  const snapshotGeometryReady = Object.values(snapshotRegion).every((value) => Number.isFinite(value) && Number(value.toFixed(6)) === value)
    && snapshotRegion.x >= 0 && snapshotRegion.y >= 0 && snapshotRegion.x < 1 && snapshotRegion.y < 1
    && snapshotRegion.width > 0 && snapshotRegion.height > 0
    && snapshotRegion.x + snapshotRegion.width <= 1 && snapshotRegion.y + snapshotRegion.height <= 1;
  const rasterAvailable = isEngineAvailable('magick');
  const ocrLanguages = Object.freeze([...(state.ocrLanguages ?? [])]);
  const protectedArtifact = state.pdfkitProtectionResult?.artifact;
  return freezeEditorReadiness({
    state, info, isEngineAvailable, ready, rasterAvailable, ocrLanguages,
    incrementalMetadataReady, incrementalBleedBoxReady, incrementalGoToLinkReady,
    incrementalGoToLinkEditorReady, namedDestinationReadiness,
    incrementalPageVectorReady, incrementalPageVectorEditorReady, pageTextReady,
    pageTextEditorReady, fullPageRedactionReady, accessibilityMetadataReadiness,
    altTextReadiness, unsigned, formKind, analysis, structure,
    javascriptRemovalReady, annotationFlattenReady, mutationReady, legacyReady,
    selectedWidget, existingAnnotations, localLinkReady, localGoToRemovalReady,
    boundedPageCount, outline, outlineCount, outlineRemovalReady, outlineRenameReady,
    requestedRotation, currentRotation, pageBoxReadiness, safeRewriteSource,
    protectedArtifact, snapshotGeometryReady, snapshotDpi,
  });
}
