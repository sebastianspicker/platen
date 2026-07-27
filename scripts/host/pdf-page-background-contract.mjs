export const PDF_PAGE_BACKGROUND_PROFILE = 'local-classic-solid-page-background-v1';
export const PDF_PAGE_BACKGROUND_LIMITS = Object.freeze({
  maxPages: 500,
  maxSourceBytes: 128 * 1024 * 1024,
  maxAppendBytes: 64 * 1024,
  maxColorPrecision: 6,
});

const SHA256 = /^[0-9a-f]{64}$/u;

function invalid(message = 'PDF page-background request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_PDF_PAGE_BACKGROUND';
  return error;
}

function exactObject(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== required.length || keys.some((key) => typeof key !== 'string' || !required.includes(key))
    || required.some((key) => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw invalid();
  return descriptors;
}

function number(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1
    || Object.is(value, -0) || Math.round(value * 10 ** PDF_PAGE_BACKGROUND_LIMITS.maxColorPrecision) !== value * 10 ** PDF_PAGE_BACKGROUND_LIMITS.maxColorPrecision) {
    throw invalid(`${name} must be a finite RGB component between 0 and 1 with at most six decimal places.`);
  }
  return value === 0 ? 0 : value;
}

function normalizeColor(value) {
  const descriptors = exactObject(value, ['r', 'g', 'b']);
  return Object.freeze({
    r: number(descriptors.r.value, 'r'),
    g: number(descriptors.g.value, 'g'),
    b: number(descriptors.b.value, 'b'),
  });
}

export function normalizePdfPageBackground(value) {
  const request = exactObject(value, ['profile', 'sourceSha256', 'pages', 'color']);
  if (request.profile.value !== PDF_PAGE_BACKGROUND_PROFILE
    || typeof request.sourceSha256.value !== 'string' || !SHA256.test(request.sourceSha256.value)) throw invalid();
  const pages = request.pages.value;
  if (!Array.isArray(pages) || Object.getPrototypeOf(pages) !== Array.prototype
    || Object.getOwnPropertySymbols(pages).length !== 0 || pages.length < 1 || pages.length > PDF_PAGE_BACKGROUND_LIMITS.maxPages) throw invalid();
  const pageDescriptors = Object.getOwnPropertyDescriptors(pages);
  if (!Number.isSafeInteger(pageDescriptors.length?.value)
    || Object.keys(pageDescriptors).length !== pageDescriptors.length.value + 1) throw invalid();
  const normalizedPages = [];
  let previous = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const descriptor = pageDescriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw invalid();
    const page = descriptor.value;
    if (!Number.isSafeInteger(page) || page < 1 || page > PDF_PAGE_BACKGROUND_LIMITS.maxPages || page <= previous) throw invalid('Pages must be unique, strictly ascending one-based integers.');
    normalizedPages.push(page); previous = page;
  }
  return Object.freeze({ profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: request.sourceSha256.value,
    pages: Object.freeze(normalizedPages), color: normalizeColor(request.color.value) });
}

export const normalizePageBackground = normalizePdfPageBackground;
