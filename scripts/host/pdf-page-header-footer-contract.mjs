export const PDF_PAGE_HEADER_FOOTER_PROFILE = 'local-pdf-page-header-footer-v1';
export const PDF_PAGE_HEADER_FOOTER_LIMITS = Object.freeze({
  maxPages: 500,
  maxSourceBytes: 32 * 1024 * 1024,
  maxTextBytes: 256,
  maxTextCodePoints: 80,
});
export const PDF_PAGE_HEADER_FOOTER_APPEARANCE = Object.freeze({
  font: 'Courier', fontSize: 12, color: Object.freeze({ r: 0, g: 0, b: 0 }),
  headerPosition: 'top-center', footerPosition: 'bottom-center',
});

const SHA256 = /^[0-9a-f]{64}$/u;
function invalid(message = 'PDF page header/footer request is invalid.') { const error = new Error(message); error.code = 'INVALID_PDF_PAGE_HEADER_FOOTER'; throw error; }
function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) invalid();
  return descriptors;
}
function pages(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0
    || value.length < 1 || value.length > PDF_PAGE_HEADER_FOOTER_LIMITS.maxPages) invalid('Pages must be a bounded ascending list.');
  const descriptors = Object.getOwnPropertyDescriptors(value); if (!Number.isSafeInteger(descriptors.length?.value) || Object.keys(descriptors).length !== value.length + 1) invalid();
  let previous = 0; const copy = value.map((page, index) => {
    const descriptor = descriptors[index]; if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
      || !Number.isSafeInteger(page) || page < 1 || page > PDF_PAGE_HEADER_FOOTER_LIMITS.maxPages || page <= previous) invalid('Pages must be strictly ascending one-based integers.');
    previous = page; return page;
  });
  return Object.freeze(copy);
}
function text(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value !== value.normalize('NFC') || [...value].length > PDF_PAGE_HEADER_FOOTER_LIMITS.maxTextCodePoints
    || Buffer.byteLength(value, 'utf8') > PDF_PAGE_HEADER_FOOTER_LIMITS.maxTextBytes || !/^[\x20-\x7E]+$/u.test(value)) invalid(`${label} must be bounded NFC-normalized printable ASCII.`);
  return value;
}
export function normalizePdfPageHeaderFooter(value) {
  const request = exactObject(value, ['profile', 'sourceSha256', 'pages', 'header', 'footerPrefix']);
  if (request.profile.value !== PDF_PAGE_HEADER_FOOTER_PROFILE || typeof request.sourceSha256.value !== 'string' || !SHA256.test(request.sourceSha256.value)) invalid();
  return Object.freeze({ profile: PDF_PAGE_HEADER_FOOTER_PROFILE, sourceSha256: request.sourceSha256.value, pages: pages(request.pages.value), header: text(request.header.value, 'header'), footerPrefix: text(request.footerPrefix.value, 'footerPrefix') });
}
export const normalizePageHeaderFooter = normalizePdfPageHeaderFooter;
