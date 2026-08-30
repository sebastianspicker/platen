export const MAX_PAGE_TEXT_CLIPBOARD_UNITS = 20_000;

export function pageTextForClipboard(pages, page) {
  if (!Array.isArray(pages) || !Number.isSafeInteger(page) || page < 1) return null;
  const text = pages.find((entry) => entry?.page === page)?.text;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed && trimmed.length <= MAX_PAGE_TEXT_CLIPBOARD_UNITS ? trimmed : null;
}

export function clipboardTextWritingAvailable(clipboard = globalThis.navigator?.clipboard) {
  return typeof clipboard?.writeText === 'function';
}
