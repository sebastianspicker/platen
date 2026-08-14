export const MAX_READ_ALOUD_CHARACTERS = 20_000;

export function readAloudText(pages, page, maximum = MAX_READ_ALOUD_CHARACTERS) {
  if (!Array.isArray(pages) || !Number.isSafeInteger(page) || page < 1) return null;
  const limit = Number.isSafeInteger(maximum) && maximum > 0 ? Math.min(maximum, MAX_READ_ALOUD_CHARACTERS) : MAX_READ_ALOUD_CHARACTERS;
  const text = String(pages.find((item) => item?.page === page)?.text ?? '').trim();
  return text ? text.slice(0, limit) : null;
}
