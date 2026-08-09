export const PDF_PAGE_WATERMARK_PROFILE = 'local-pdf-page-watermark-v1';
export const PDF_PAGE_WATERMARK_LIMITS = Object.freeze({
  maxPages: 500,
  maxSourceBytes: 32 * 1024 * 1024,
  maxTextCodePoints: 80,
  maxTextBytes: 256,
});
export const PDF_PAGE_WATERMARK_APPEARANCE = Object.freeze({
  font: 'Helvetica',
  fontSize: 36,
  color: Object.freeze({ r: 0, g: 0, b: 0 }),
  opacity: 1,
  position: 'center',
  rotation: 0,
});

const SHA256 = /^[0-9a-f]{64}$/u;

function invalid(message = 'PDF page-watermark request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_PDF_PAGE_WATERMARK';
  throw error;
}

function exactObject(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== required.length || keys.some((key) => typeof key !== 'string' || !required.includes(key))
    || required.some((key) => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) invalid();
  return descriptors;
}

function normalizePages(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0
    || value.length < 1 || value.length > PDF_PAGE_WATERMARK_LIMITS.maxPages) invalid('Pages must be a bounded ascending list.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Number.isSafeInteger(descriptors.length?.value) || Object.keys(descriptors).length !== descriptors.length.value + 1) invalid();
  const pages = [];
  let previous = 0;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalid();
    const page = descriptor.value;
    if (!Number.isSafeInteger(page) || page < 1 || page > PDF_PAGE_WATERMARK_LIMITS.maxPages || page <= previous) invalid('Pages must be unique, strictly ascending one-based integers.');
    pages.push(page); previous = page;
  }
  return Object.freeze(pages);
}

function normalizeText(value) {
  if (typeof value !== 'string' || value.length < 1 || value !== value.normalize('NFC')
    || [...value].length > PDF_PAGE_WATERMARK_LIMITS.maxTextCodePoints
    || Buffer.byteLength(value, 'utf8') > PDF_PAGE_WATERMARK_LIMITS.maxTextBytes
    || !/^[\x20-\x7E]*$/u.test(value)) invalid('Watermark text must be bounded, NFC-normalized printable ASCII.');
  return value;
}

export function normalizePdfPageWatermark(value) {
  const request = exactObject(value, ['profile', 'sourceSha256', 'pages', 'text']);
  if (request.profile.value !== PDF_PAGE_WATERMARK_PROFILE || typeof request.sourceSha256.value !== 'string' || !SHA256.test(request.sourceSha256.value)) invalid();
  return Object.freeze({ profile: PDF_PAGE_WATERMARK_PROFILE, sourceSha256: request.sourceSha256.value, pages: normalizePages(request.pages.value), text: normalizeText(request.text.value) });
}

export const normalizePageWatermark = normalizePdfPageWatermark;
