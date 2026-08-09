import { types as nodeTypes } from 'node:util';

export const PDF_ACCESSIBILITY_LINKS_BOOKMARKS_PROFILE = 'local-classic-incremental-links-bookmarks-v1';
export const ACCESSIBILITY_LINKS_BOOKMARKS_PROFILE = PDF_ACCESSIBILITY_LINKS_BOOKMARKS_PROFILE;

const MAX_ITEMS = 64;
const MAX_TEXT = 256;
const HASH = /^[0-9a-f]{64}$/u;

function invalid(message = 'Accessibility links/bookmarks request is invalid.') {
  const error = new Error(message);
  error.code = 'INVALID_ACCESSIBILITY_LINKS_BOOKMARKS';
  return error;
}

function exactObject(value, keys) {
  try {
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
      || keys.some((key) => !Object.hasOwn(descriptors, key)
        || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) throw invalid();
    return descriptors;
  } catch (error) { if (error?.code === 'INVALID_ACCESSIBILITY_LINKS_BOOKMARKS') throw error; throw invalid(); }
}

function boundedText(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TEXT
    || value.normalize('NFC') !== value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff\u202e\u202d\u202c\u2066-\u2069]/u.test(value)) throw invalid();
  return value;
}

function locator(value) {
  const fields = exactObject(value, ['fingerprint']);
  if (typeof fields.fingerprint.value !== 'string' || !HASH.test(fields.fingerprint.value)) throw invalid();
  return Object.freeze({ fingerprint: fields.fingerprint.value });
}

function array(value) {
  let descriptors;
  try {
    if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length) throw invalid();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) { if (error?.code === 'INVALID_ACCESSIBILITY_LINKS_BOOKMARKS') throw error; throw invalid(); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ITEMS
    || Object.keys(descriptors).length !== length + 1
    || !Object.hasOwn(descriptors, 'length') || descriptors.length.enumerable !== false) throw invalid();
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw invalid();
  }
  return Array.from({ length }, (_, index) => descriptors[index].value);
}

export function normalizePdfAccessibilityLinksBookmarks(value) {
  const fields = exactObject(value, ['profile', 'sourceSha256', 'links', 'bookmarks']);
  if (fields.profile.value !== PDF_ACCESSIBILITY_LINKS_BOOKMARKS_PROFILE) throw invalid();
  if (typeof fields.sourceSha256.value !== 'string' || !HASH.test(fields.sourceSha256.value)) throw invalid();
  const links = array(fields.links.value).map((entry) => {
    const row = exactObject(entry, ['locator', 'purpose', 'targetPage']);
    const targetPage = row.targetPage.value;
    if (!Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > 100) throw invalid();
    return Object.freeze({ locator: locator(row.locator.value), purpose: boundedText(row.purpose.value), targetPage });
  });
  const bookmarks = array(fields.bookmarks.value).map((entry) => {
    const row = exactObject(entry, ['locator', 'title', 'targetPage']);
    const targetPage = row.targetPage.value;
    if (!Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > 100) throw invalid();
    return Object.freeze({ locator: locator(row.locator.value), title: boundedText(row.title.value), targetPage });
  });
  if (links.length + bookmarks.length < 1 || links.length + bookmarks.length > MAX_ITEMS) throw invalid('The repair must select from one through 64 source locators.');
  const fingerprints = [...links, ...bookmarks].map((entry) => entry.locator.fingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) throw invalid('A source locator may be used only once.');
  return Object.freeze({
    profile: PDF_ACCESSIBILITY_LINKS_BOOKMARKS_PROFILE,
    sourceSha256: fields.sourceSha256.value,
    links: Object.freeze(links), bookmarks: Object.freeze(bookmarks),
  });
}

export const normalizeAccessibilityLinksBookmarks = normalizePdfAccessibilityLinksBookmarks;
export { MAX_ITEMS as MAX_ACCESSIBILITY_LINKS_BOOKMARKS_ITEMS, MAX_TEXT as MAX_ACCESSIBILITY_LINKS_BOOKMARKS_TEXT };
