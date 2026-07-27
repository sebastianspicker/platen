import {
  isSupportedPdfKitFormWidget,
  pdfKitLocalGoToRemovalCandidates,
} from '../../core/pdfkit-workflow-contract.js';
import {
  movePageNavigation,
  transitionPageNavigation,
} from '../../core/navigation-history.js';

const EDITABLE_ANNOTATION_TYPES = new Set([
  'freeText',
  'square',
  'circle',
  'highlight',
]);
const RIGHT_ANGLE_ROTATIONS = new Set([0, 90, 180, 270]);

function selectPdfKitTargets(state, page) {
  if (state.pdfkitInspectionResult?.sourceDigest !== state.analysis.sha256) return;
  const inventory = state.pdfkitInspectionResult.pages?.find((entry) => entry.index === page);
  const widget = inventory?.widgets?.find(isSupportedPdfKitFormWidget);
  const annotation = inventory?.annotations?.find(({ subtype }) => (
    EDITABLE_ANNOTATION_TYPES.has(subtype)
  ));
  state.pdfkitWidgetIndex = widget ? String(widget.annotationIndex) : '';
  state.pdfkitExistingAnnotationIndex = annotation
    ? String(annotation.annotationIndex)
    : '';
  const localLink = pdfKitLocalGoToRemovalCandidates(
    inventory,
    state.pdfkitInspectionResult.pageCount,
  )[0];
  state.pdfkitLocalLinkRemovalIndex = localLink ? String(localLink.annotationIndex) : '';
  if (RIGHT_ANGLE_ROTATIONS.has(inventory?.rotation)) {
    state.pdfkitPageRotation = String((inventory.rotation + 90) % 360);
  }
  const crop = inventory?.boxes?.crop;
  if (crop) {
    state.pdfkitPageBoxRect = { ...crop };
    state.pdfkitLinkRect = {
      x: crop.x + Math.min(36, Math.max(0, crop.width / 10)),
      y: crop.y + Math.min(36, Math.max(0, crop.height / 10)),
      width: Math.min(180, Math.max(1, crop.width / 2)),
      height: Math.min(40, Math.max(1, crop.height / 12)),
    };
    state.pdfkitLineStart = {
      x: crop.x + crop.width * 0.2,
      y: crop.y + crop.height * 0.25,
    };
    state.pdfkitLineEnd = {
      x: crop.x + crop.width * 0.8,
      y: crop.y + crop.height * 0.75,
    };
    state.pdfkitInkPoints = [
      [crop.x + crop.width * 0.2, crop.y + crop.height * 0.25],
      [crop.x + crop.width * 0.5, crop.y + crop.height * 0.5],
      [crop.x + crop.width * 0.8, crop.y + crop.height * 0.75],
    ].map((entry) => entry.join(',')).join(';');
  }
  state.pdfkitMutationResult = null;
}

export function createViewerNavigationController({
  state,
  selectionTracker,
  resetLoupe,
  loadControlledRaster,
  clearOcrLayoutSelection,
  render,
  announce,
}) {
  function setSelectedPageIdentity(page) {
    const changed = state.selectedPage !== page;
    state.selectedPage = page;
    if (changed) {
      selectionTracker.generation += 1;
      resetLoupe('The selected page changed.');
    }
    return changed;
  }

  function selectPage(page, {
    recordHistory = true,
    targetHistoryIndex = null,
    announcement = `Page ${page} selected.`,
  } = {}) {
    const pageCount = state.analysis.inspection?.pageCount ?? 0;
    const navigation = transitionPageNavigation(
      state.navigationHistory,
      state.navigationIndex,
      state.selectedPage,
      page,
      { pageCount, record: recordHistory, targetIndex: targetHistoryIndex },
    );
    if (!navigation?.changed) return false;
    if (!setSelectedPageIdentity(page)) return false;

    state.navigationHistory = [...navigation.history];
    state.navigationIndex = navigation.index;
    selectPdfKitTargets(state, page);
    if (state.prepressResult?.page && state.prepressResult.page !== page) {
      state.prepressResult = null;
    }
    state.selectedOcrZoneId = state.ocrZones.find((zone) => zone.page === page)?.id ?? null;
    clearOcrLayoutSelection();
    if (announcement) announce(announcement);
    if (state.viewerMode === 'controlled') {
      void loadControlledRaster(page);
    } else {
      render();
    }
    return true;
  }

  function navigateHistory(offset) {
    const next = movePageNavigation(
      state.navigationHistory,
      state.navigationIndex,
      offset,
    );
    if (!next) return;
    selectPage(next.page, {
      recordHistory: false,
      targetHistoryIndex: next.index,
    });
  }

  return Object.freeze({ setSelectedPageIdentity, selectPage, navigateHistory });
}
