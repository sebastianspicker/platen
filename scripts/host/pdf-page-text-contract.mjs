export const PDF_PAGE_TEXT_PROFILE = 'local-page-text-run-v1';
export const PDF_PAGE_TEXT_MAX_PAGES = 100;
export const PDF_PAGE_TEXT_MAX_COORDINATE = 1_000_000;
export const PDF_PAGE_TEXT_MAX_BYTES = 512;

function invalid(message = 'Page text request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_PAGE_TEXT';
  return error;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw invalid();
  }
  return descriptors;
}

function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid();
  return value;
}

function canonicalText(value) {
  if (typeof value !== 'string' || value.length < 1
    || Buffer.byteLength(value, 'utf8') > PDF_PAGE_TEXT_MAX_BYTES
    || value.normalize('NFC') !== value || value.trim() !== value
    || /[^\u0020-\u007e]/u.test(value)) throw invalid();
  return value;
}

export function escapePageTextPdfLiteral(value) {
  const text = canonicalText(value);
  return text.replace(/[()\\]/gu, '\\$&');
}

export function normalizePageTextRequest(value) {
  const request = exactObject(value, ['profile', 'page', 'x', 'y', 'size', 'text']);
  if (request.profile.value !== PDF_PAGE_TEXT_PROFILE) throw invalid();
  return Object.freeze({
    profile: PDF_PAGE_TEXT_PROFILE,
    page: integer(request.page.value, 1, PDF_PAGE_TEXT_MAX_PAGES),
    x: integer(request.x.value, -PDF_PAGE_TEXT_MAX_COORDINATE, PDF_PAGE_TEXT_MAX_COORDINATE),
    y: integer(request.y.value, -PDF_PAGE_TEXT_MAX_COORDINATE, PDF_PAGE_TEXT_MAX_COORDINATE),
    size: integer(request.size.value, 6, 72),
    text: canonicalText(request.text.value),
  });
}
