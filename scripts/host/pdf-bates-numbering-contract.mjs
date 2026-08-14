export const PDF_BATES_NUMBERING_PROFILE = 'local-pdf-bates-numbering-v1';

const MAX_PAGES = 500;
const MAX_COORDINATE = 1_000_000;
const MAX_TEXT_BYTES = 256;
const REQUEST_KEYS = ['profile', 'sourceSha256', 'pages', 'start', 'prefix', 'suffix', 'padding', 'position', 'margin', 'fontSize'];
const POSITIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];

function invalid(message = 'The Bates-numbering request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_PDF_BATES_NUMBERING';
  throw error;
}

function hasOnlyStringKeys(value) {
  return !Reflect.ownKeys(value).some((key) => typeof key !== 'string');
}

function hasExpectedEnumerableKeys(value, keys) {
  return Object.keys(value).length === keys.length && !Object.keys(value).some((key) => !keys.includes(key));
}

function hasEnumerableDataDescriptors(value) {
  return !Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true);
}

function exact(value, keys) {
  if (!value) invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
  if (!hasOnlyStringKeys(value)) invalid();
  if (!hasExpectedEnumerableKeys(value, keys)) invalid();
  if (!hasEnumerableDataDescriptors(value)) invalid();
  return value;
}

function isBoundedPrintableAscii(value) {
  return typeof value === 'string'
    && value.length >= 0
    && [...value].length <= 64
    && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES
    && value === value.normalize('NFC')
    && /^[\x20-\x7E]*$/u.test(value);
}

function text(value) {
  if (!isBoundedPrintableAscii(value)) invalid('prefix and suffix must be bounded printable ASCII text.');
  return value;
}

function hasValidRequestIdentity(request) {
  return request.profile === PDF_BATES_NUMBERING_PROFILE
    && typeof request.sourceSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(request.sourceSha256)
    && Array.isArray(request.pages)
    && Object.getPrototypeOf(request.pages) === Array.prototype
    && Object.getOwnPropertySymbols(request.pages).length === 0;
}

function hasValidPages(request) {
  const pageDescriptors = Object.getOwnPropertyDescriptors(request.pages);
  if (request.pages.length < 1) return false;
  if (request.pages.length > MAX_PAGES) return false;
  const elementDescriptors = Object.entries(pageDescriptors).filter(([key]) => key !== 'length');
  if (elementDescriptors.length !== request.pages.length) return false;
  if (!elementDescriptors.every(([, descriptor]) => enumerableDataDescriptor(descriptor))) return false;
  if (!request.pages.every(boundedBatesPage)) return false;
  return pagesAreStrictlyAscending(request);
}

function enumerableDataDescriptor(descriptor) {
  if (!Object.hasOwn(descriptor, 'value')) return false;
  return descriptor.enumerable === true;
}

function boundedBatesPage(page) {
  return Number.isSafeInteger(page) && page >= 1 && page <= MAX_PAGES;
}

function pagesAreStrictlyAscending(request) {
  return request.pages.every((page, index) => {
    if (index === 0) return true;
    return page > request.pages[index - 1];
  });
}

function hasValidNumbers(request) {
  return Number.isSafeInteger(request.start)
    && request.start >= 0
    && request.start <= 999_999_999
    && request.start + request.pages.length - 1 <= 999_999_999
    && Number.isSafeInteger(request.padding)
    && request.padding >= 1
    && request.padding <= 12;
}

function hasValidLayout(request) {
  if (!POSITIONS.includes(request.position)) return false;
  if (!requestHasValidMargin(request)) return false;
  return requestHasValidFontSize(request);
}

function requestHasValidMargin(request) {
  if (typeof request.margin !== 'number') return false;
  if (!Number.isFinite(request.margin)) return false;
  if (request.margin < 0) return false;
  return request.margin <= MAX_COORDINATE;
}

function requestHasValidFontSize(request) {
  if (typeof request.fontSize !== 'number') return false;
  if (!Number.isFinite(request.fontSize)) return false;
  if (request.fontSize <= 0) return false;
  return request.fontSize <= 200;
}

function exceedsRenderedTextByteBound(prefix, suffix, request) {
  const rendered = `${prefix}${request.start + request.pages.length - 1}`.padStart(request.padding + prefix.length, '0') + suffix;
  return Buffer.byteLength(rendered, 'latin1') > MAX_TEXT_BYTES;
}

export function normalizePdfBatesNumbering(value) {
  const request = exact(value, REQUEST_KEYS);
  if (!hasValidRequestIdentity(request)) invalid();
  const validPages = hasValidPages(request);
  const validNumbers = hasValidNumbers(request);
  const validLayout = hasValidLayout(request);
  if (!validPages || !validNumbers || !validLayout) invalid();
  const prefix = text(request.prefix);
  const suffix = text(request.suffix);
  if (exceedsRenderedTextByteBound(prefix, suffix, request)) invalid('The rendered Bates text exceeds its byte bound.');
  return Object.freeze({ profile: request.profile, sourceSha256: request.sourceSha256, pages: Object.freeze([...new Set(request.pages)]), start: request.start, prefix, suffix, padding: request.padding, position: request.position, margin: request.margin, fontSize: request.fontSize });
}
