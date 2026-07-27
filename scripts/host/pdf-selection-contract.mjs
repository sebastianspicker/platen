import { HostError } from './host-error.mjs';
import { MAX_COMPOSE_PAGES, MAX_COMPOSE_SOURCES } from './pdf-service-limits.mjs';

export function validatePages(pages, pageCount) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > pageCount) {
    throw new HostError('INVALID_PAGES', 'Choose at least one page within the document.', 400);
  }
  if (pages.length > MAX_COMPOSE_PAGES) {
    throw new HostError(
      'COMPOSE_PAGE_LIMIT',
      `A single derived page operation is limited to ${MAX_COMPOSE_PAGES} pages.`,
      422,
    );
  }
  return pages.map((page) => {
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
      throw new HostError('INVALID_PAGES', `Page ${page} is outside this document.`, 400);
    }
    return page;
  });
}

export function validateSelections(selections) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new HostError('INVALID_PAGE_SELECTIONS', 'Choose at least one source page.', 400);
  }
  if (selections.length > MAX_COMPOSE_PAGES) {
    throw new HostError(
      'COMPOSE_PAGE_LIMIT',
      `A single derived page operation is limited to ${MAX_COMPOSE_PAGES} pages.`,
      422,
    );
  }
  const sources = new Set();
  const checked = selections.map((selection, index) => {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
      throw new HostError('INVALID_PAGE_SELECTIONS', `Selection ${index + 1} is invalid.`, 400);
    }
    const documentId = String(selection.documentId ?? '');
    const page = selection.page;
    if (!documentId || !Number.isSafeInteger(page) || page < 1) {
      throw new HostError('INVALID_PAGE_SELECTIONS', `Selection ${index + 1} needs a document and positive page number.`, 400);
    }
    sources.add(documentId);
    return Object.freeze({ documentId, page });
  });
  if (sources.size > MAX_COMPOSE_SOURCES) {
    throw new HostError('COMPOSE_SOURCE_LIMIT', `A composition may use at most ${MAX_COMPOSE_SOURCES} source PDFs.`, 422);
  }
  return Object.freeze(checked);
}

export function renderDimensionForDpi(dpi) {
  if (!Number.isSafeInteger(dpi) || dpi < 36 || dpi > 240) {
    throw new HostError('INVALID_PARAMETER', 'dpi must be an integer from 36 through 240.', 400);
  }
  return Math.min(2_880, Math.max(512, dpi * 12));
}

