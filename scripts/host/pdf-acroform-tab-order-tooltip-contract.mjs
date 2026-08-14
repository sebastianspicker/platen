export const PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE = 'local-pdf-acroform-tab-order-tooltip-v1';
export const PDF_ACROFORM_TAB_ORDER_TOOLTIPS_PROFILE = PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE;

const SHA256 = /^[0-9a-f]{64}$/u;
const FINGERPRINT = SHA256;
const MAX_TOOLTIP_CHARS = 127;
const MAX_TOOLTIP_BYTES = 512;

function invalid(message = 'AcroForm tab-order and tooltip request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_PDF_ACROFORM_TAB_ORDER_TOOLTIP';
  return error;
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) throw invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function boundedText(value) {
  if (typeof value !== 'string' || value.length < 1 || [...value].length > MAX_TOOLTIP_CHARS
    || Buffer.byteLength(value, 'utf8') > MAX_TOOLTIP_BYTES || value !== value.normalize('NFC')
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value)) throw invalid('tooltip must be bounded NFC text.');
  return value;
}

function locator(value) {
  const target = exact(value, ['page', 'annotationIndex', 'fingerprint']);
  if (!Number.isSafeInteger(target.page) || target.page < 1 || target.page > 10_000
    || !Number.isSafeInteger(target.annotationIndex) || target.annotationIndex < 0 || target.annotationIndex >= 50
    || !FINGERPRINT.test(target.fingerprint)) throw invalid('target must be a bounded source-bound widget locator.');
  return Object.freeze({ page: target.page, annotationIndex: target.annotationIndex, fingerprint: target.fingerprint });
}

function normalizeInternal(value) {
  // The nested target is canonical. The flat form is retained as a strict
  // compatibility alias for callers that already use flat AcroForm locators.
  const keys = Object.keys(value ?? {});
  let request;
  if (keys.length === 4 && keys.every((key) => ['profile', 'sourceSha256', 'target', 'tooltip'].includes(key))) {
    request = exact(value, ['profile', 'sourceSha256', 'target', 'tooltip']);
  } else if (keys.length === 6 && keys.every((key) => ['profile', 'sourceSha256', 'page', 'annotationIndex', 'fingerprint', 'tooltip'].includes(key))) {
    const flat = exact(value, ['profile', 'sourceSha256', 'page', 'annotationIndex', 'fingerprint', 'tooltip']);
    request = { profile: flat.profile, sourceSha256: flat.sourceSha256, target: { page: flat.page, annotationIndex: flat.annotationIndex, fingerprint: flat.fingerprint }, tooltip: flat.tooltip };
  } else throw invalid('request contains unsupported fields.');
  if (request.profile !== PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE || !SHA256.test(request.sourceSha256 ?? '')) throw invalid('profile and sourceSha256 are invalid.');
  return Object.freeze({ profile: PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE, sourceSha256: request.sourceSha256, target: locator(request.target), tooltip: boundedText(request.tooltip) });
}

export function normalizePdfAcroFormTabOrderTooltip(value) {
  try { return normalizeInternal(value); } catch (error) { if (error?.code === 'INVALID_PDF_ACROFORM_TAB_ORDER_TOOLTIP') throw error; throw invalid(); }
}

export const normalizePdfAcroFormTabOrderTooltips = normalizePdfAcroFormTabOrderTooltip;
export const TAB_ORDER_TOOLTIP_LIMITS = Object.freeze({ maxTooltipChars: MAX_TOOLTIP_CHARS, maxTooltipBytes: MAX_TOOLTIP_BYTES, maxPages: 10_000, maxAnnotationsPerPage: 50 });
