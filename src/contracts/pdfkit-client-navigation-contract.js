import { validPdfKitOutlineLabel } from './pdfkit-outline-label.js';
import {
  exactObject,
  validPdfKitLocator,
  validPdfKitOutlineLocator,
  validPdfKitPoint,
  validPdfKitRectangle,
} from './pdfkit-client-contract-shared.js';

export function validPdfKitLocalGoToMutation(mutation) {
  if (!exactObject(mutation, ['link'])
    || !exactObject(mutation.link, ['sourcePage', 'targetPage', 'rect'])) return false;
  return Number.isSafeInteger(mutation.link.sourcePage)
    && mutation.link.sourcePage >= 1 && mutation.link.sourcePage <= 100
    && Number.isSafeInteger(mutation.link.targetPage)
    && mutation.link.targetPage >= 1 && mutation.link.targetPage <= 100
    && validPdfKitRectangle(mutation.link.rect);
}

export function validPdfKitLocalGoToRemovalMutation(mutation) {
  return exactObject(mutation, ['linkRemoval'])
    && validPdfKitLocator(mutation.linkRemoval);
}

export function validPdfKitOutlineMutation(mutation) {
  return exactObject(mutation, ['bookmark'])
    && exactObject(mutation.bookmark, ['page', 'label'])
    && Number.isSafeInteger(mutation.bookmark.page)
    && mutation.bookmark.page >= 1 && mutation.bookmark.page <= 100
    && validPdfKitOutlineLabel(mutation.bookmark.label);
}

export function validPdfKitOutlineRemovalMutation(mutation) {
  return exactObject(mutation, ['bookmarkRemoval'])
    && validPdfKitOutlineLocator(mutation.bookmarkRemoval);
}

export function validPdfKitOutlineRenameMutation(mutation) {
  return exactObject(mutation, ['bookmarkRename'])
    && exactObject(mutation.bookmarkRename, ['topLevelIndex', 'fingerprint', 'label'])
    && validPdfKitOutlineLocator({
      topLevelIndex: mutation.bookmarkRename.topLevelIndex,
      fingerprint: mutation.bookmarkRename.fingerprint,
    })
    && validPdfKitOutlineLabel(mutation.bookmarkRename.label);
}

export function validPdfKitLineAnnotationMutation(mutation) {
  if (!exactObject(mutation, ['line'])
    || !exactObject(mutation.line, ['page', 'contents', 'start', 'end'])) return false;
  const bytes = typeof mutation.line.contents === 'string'
    ? new TextEncoder().encode(mutation.line.contents).byteLength : 0;
  return Number.isSafeInteger(mutation.line.page)
    && mutation.line.page >= 1 && mutation.line.page <= 100
    && bytes >= 1 && bytes <= 1_024
    && validPdfKitPoint(mutation.line.start) && validPdfKitPoint(mutation.line.end)
    && (mutation.line.start.x !== mutation.line.end.x
      || mutation.line.start.y !== mutation.line.end.y);
}

export function validPdfKitInkAnnotationMutation(mutation) {
  if (!exactObject(mutation, ['ink'])
    || !exactObject(mutation.ink, ['page', 'contents', 'points'])) return false;
  const bytes = typeof mutation.ink.contents === 'string'
    ? new TextEncoder().encode(mutation.ink.contents).byteLength : 0;
  if (!Number.isSafeInteger(mutation.ink.page)
    || mutation.ink.page < 1 || mutation.ink.page > 100
    || bytes < 1 || bytes > 1_024
    || !Array.isArray(mutation.ink.points)
    || mutation.ink.points.length < 2 || mutation.ink.points.length > 32
    || !mutation.ink.points.every(validPdfKitPoint)) return false;
  return mutation.ink.points.every((entry, index) => index === 0
    || entry.x !== mutation.ink.points[index - 1].x
    || entry.y !== mutation.ink.points[index - 1].y);
}
