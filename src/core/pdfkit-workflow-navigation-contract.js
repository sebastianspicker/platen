import { validPdfKitOutlineLabel } from './pdfkit-outline-label.js';
import {
  boundedPdfKitContents,
  boundedPdfKitPoint,
  boundedPdfKitRectangle,
  PDFKIT_WORKFLOW_SHA256,
  selectedPdfKitInventoryPage,
} from './pdfkit-workflow-contract-shared.js';

export function buildPdfKitLocalGoToMutation(state) {
  const targetPage = Number(state.pdfkitLinkTargetPage);
  if (!Number.isSafeInteger(targetPage) || targetPage < 1
    || targetPage > state.pdfkitInspectionResult?.pageCount) {
    throw new Error('Choose an existing target page for the local link.');
  }
  return {
    link: {
      sourcePage: state.selectedPage,
      targetPage,
      rect: boundedPdfKitRectangle(state, state.pdfkitLinkRect, 'Local link', 'crop'),
    },
  };
}

export function pdfKitLocalGoToRemovalCandidates(page, pageCount) {
  if (!page || page.annotationsTruncated !== false || page.linksTruncated !== false
    || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100) return [];
  const annotations = new Map(
    (page.annotations ?? []).map((entry) => [entry.annotationIndex, entry]),
  );
  return (page.links ?? []).flatMap((link) => {
    const annotation = annotations.get(link.annotationIndex);
    if (link.kind !== 'goTo' || !Number.isSafeInteger(link.targetPage)
      || link.targetPage < 1 || link.targetPage > pageCount
      || annotation?.subtype !== 'link'
      || !PDFKIT_WORKFLOW_SHA256.test(annotation.fingerprint ?? '')) return [];
    return [{ ...link, fingerprint: annotation.fingerprint }];
  });
}

export function buildPdfKitLocalGoToRemovalMutation(state) {
  const page = selectedPdfKitInventoryPage(state);
  const annotationIndex = Number(state.pdfkitLocalLinkRemovalIndex);
  const candidate = pdfKitLocalGoToRemovalCandidates(
    page,
    state.pdfkitInspectionResult?.pageCount,
  ).find((entry) => entry.annotationIndex === annotationIndex);
  if (!candidate) {
    throw new Error('Choose a fully inspected source-bound local page link candidate.');
  }
  return {
    linkRemoval: {
      page: page.index,
      annotationIndex,
      fingerprint: candidate.fingerprint,
    },
  };
}

export function buildPdfKitOutlineMutation(state) {
  const page = Number(state.pdfkitOutlineTargetPage);
  const label = String(state.pdfkitOutlineLabel ?? '');
  if (!Number.isSafeInteger(page) || page < 1
    || page > state.pdfkitInspectionResult?.pageCount) {
    throw new Error('Choose an existing target page for the bookmark.');
  }
  if (!validPdfKitOutlineLabel(label)) {
    throw new Error('Bookmark label must contain 1 through 1,024 canonical UTF-8 bytes without edge whitespace or control characters.');
  }
  return { bookmark: { page, label } };
}

export function pdfKitOutlineRemovalCandidates(outline) {
  if (!outline || outline.truncated !== false || !Array.isArray(outline.items)
    || outline.items.length < 1 || outline.items.length > 200) return [];
  return outline.items.flatMap((item, topLevelIndex) => {
    const locator = item?.removalLocator;
    if (!Array.isArray(item?.children) || item.children.length !== 0
      || !locator || locator.topLevelIndex !== topLevelIndex
      || !PDFKIT_WORKFLOW_SHA256.test(locator.fingerprint ?? '')) return [];
    return [{
      topLevelIndex,
      fingerprint: locator.fingerprint,
      title: typeof item.title === 'string' ? item.title : null,
      page: Number.isSafeInteger(item.page) ? item.page : null,
    }];
  });
}

export function buildPdfKitOutlineRemovalMutation(state) {
  const topLevelIndex = Number(state.pdfkitOutlineRemovalIndex);
  const candidate = pdfKitOutlineRemovalCandidates(
    state.pdfkitInspectionResult?.outline,
  ).find((item) => item.topLevelIndex === topLevelIndex);
  if (!candidate) {
    throw new Error('Choose a fully inspected source-bound top-level leaf bookmark candidate.');
  }
  return {
    bookmarkRemoval: {
      topLevelIndex,
      fingerprint: candidate.fingerprint,
    },
  };
}

export function pdfKitOutlineRenameCandidates(outline) {
  return pdfKitOutlineRemovalCandidates(outline).filter(({ title }) => typeof title === 'string');
}

export function buildPdfKitOutlineRenameMutation(state) {
  const topLevelIndex = Number(state.pdfkitOutlineRenameIndex);
  const candidate = pdfKitOutlineRenameCandidates(
    state.pdfkitInspectionResult?.outline,
  ).find((item) => item.topLevelIndex === topLevelIndex);
  if (!candidate) {
    throw new Error('Choose a fully inspected source-bound top-level leaf bookmark candidate.');
  }
  const label = String(state.pdfkitOutlineRenameLabel ?? '');
  if (!validPdfKitOutlineLabel(label)) {
    throw new Error('Bookmark label must contain 1 through 1,024 canonical UTF-8 bytes without edge whitespace or control characters.');
  }
  if (label === candidate.title) throw new Error('Choose a bookmark label that changes the selected title.');
  return {
    bookmarkRename: {
      topLevelIndex,
      fingerprint: candidate.fingerprint,
      label,
    },
  };
}

export function buildPdfKitLineAnnotationMutation(state) {
  const contents = boundedPdfKitContents(state.pdfkitLineContents, 'Line contents');
  const start = boundedPdfKitPoint(state, state.pdfkitLineStart, 'Line start');
  const end = boundedPdfKitPoint(state, state.pdfkitLineEnd, 'Line end');
  if (start.x === end.x && start.y === end.y) {
    throw new Error('Line endpoints must be distinct.');
  }
  return {
    line: {
      page: state.selectedPage,
      contents,
      start,
      end,
    },
  };
}

function inkPoints(state) {
  const value = state.pdfkitInkPoints;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Enter 2 through 32 ink points as x,y pairs separated by semicolons.');
  }
  const entries = value.split(';');
  if (entries.length < 2 || entries.length > 32) {
    throw new Error('Ink geometry requires 2 through 32 points.');
  }
  const points = entries.map((entry, index) => {
    const coordinates = entry.trim().split(',');
    if (coordinates.length !== 2
      || coordinates.some((coordinate) => coordinate.trim() === '')) {
      throw new Error(`Ink point ${index + 1} must contain exactly x,y coordinates.`);
    }
    return boundedPdfKitPoint(
      state,
      { x: Number(coordinates[0]), y: Number(coordinates[1]) },
      `Ink point ${index + 1}`,
    );
  });
  if (points.some((point, index) => index > 0
    && point.x === points[index - 1].x && point.y === points[index - 1].y)) {
    throw new Error('Ink geometry must not contain consecutive duplicate points.');
  }
  return points;
}

export function buildPdfKitInkAnnotationMutation(state) {
  return {
    ink: {
      page: state.selectedPage,
      contents: boundedPdfKitContents(state.pdfkitInkContents, 'Ink contents'),
      points: inkPoints(state),
    },
  };
}
