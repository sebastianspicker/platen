import { isProxy } from 'node:util/types';

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyRequiredKeys(keys, required) {
  return keys.length === required.length && !keys.some((key) => typeof key !== 'string' || !required.includes(key));
}

function hasRequiredDescriptors(descriptors, required) {
  return !required.some((key) => !Object.hasOwn(descriptors, key));
}

function hasOnlyEnumerableDataDescriptors(descriptors) {
  return !Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true);
}

function exactObject(value, required) {
  if (isProxy(value) || !isPlainObject(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (!hasOnlyRequiredKeys(keys, required) || !hasRequiredDescriptors(descriptors, required) || !hasOnlyEnumerableDataDescriptors(descriptors)) throw invalid();
  return descriptors;
}

function isFiniteRgbComponent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 && !Object.is(value, -0);
}

function hasRgbPrecision(value) {
  const factor = 10 ** PDF_PAGE_BACKGROUND_LIMITS.maxColorPrecision;
  return Math.round(value * factor) === value * factor;
}

function normalizeRgbComponent(value, name) {
  if (!isFiniteRgbComponent(value) || !hasRgbPrecision(value)) {
    throw invalid(`${name} must be a finite RGB component between 0 and 1 with at most six decimal places.`);
  }
  return value === 0 ? 0 : value;
}

function normalizeColor(value) {
  const descriptors = exactObject(value, ['r', 'g', 'b']);
  return Object.freeze({
    r: normalizeRgbComponent(descriptors.r.value, 'r'),
    g: normalizeRgbComponent(descriptors.g.value, 'g'),
    b: normalizeRgbComponent(descriptors.b.value, 'b'),
  });
}

function hasBoundedPageList(value) {
  return !isProxy(value)
    && Array.isArray(value)
    && Object.getPrototypeOf(value) === Array.prototype
    && Object.getOwnPropertySymbols(value).length === 0
    && value.length >= 1
    && value.length <= PDF_PAGE_BACKGROUND_LIMITS.maxPages;
}

function hasDensePageSlots(descriptors) {
  return Number.isSafeInteger(descriptors.length?.value)
    && Object.getOwnPropertyNames(descriptors).length === descriptors.length.value + 1;
}

function pageValue(descriptor) {
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw invalid();
  return descriptor.value;
}

function assertAscendingPage(page, previous) {
  if (!Number.isSafeInteger(page) || page < 1 || page > PDF_PAGE_BACKGROUND_LIMITS.maxPages || page <= previous) throw invalid('Pages must be unique, strictly ascending one-based integers.');
}

function normalizePages(value) {
  if (!hasBoundedPageList(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!hasDensePageSlots(descriptors)) throw invalid();
  const pages = [];
  let previous = 0;
  for (let index = 0; index < value.length; index += 1) {
    const page = pageValue(descriptors[index]);
    assertAscendingPage(page, previous);
    pages.push(page); previous = page;
  }
  return Object.freeze(pages);
}

export function normalizePdfPageBackground(value) {
  const request = exactObject(value, ['profile', 'sourceSha256', 'pages', 'color']);
  if (request.profile.value !== PDF_PAGE_BACKGROUND_PROFILE
    || typeof request.sourceSha256.value !== 'string' || !SHA256.test(request.sourceSha256.value)) throw invalid();
  const pages = normalizePages(request.pages.value);
  return Object.freeze({ profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: request.sourceSha256.value,
    pages, color: normalizeColor(request.color.value) });
}

export const normalizePageBackground = normalizePdfPageBackground;
