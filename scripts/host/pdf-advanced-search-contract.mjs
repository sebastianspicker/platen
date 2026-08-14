export const PDF_ADVANCED_SEARCH_PROFILE = 'local-pdf-advanced-search-v1';
export const ADVANCED_SEARCH_PROFILE = PDF_ADVANCED_SEARCH_PROFILE;

const SHA256 = /^[0-9a-f]{64}$/u;
const MODES = new Set(['literal', 'wildcard']);
const MAX_PAGES = 1_000;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_QUERY_CHARS = 128;

function invalid(message = 'PDF advanced-search request is invalid.') { const error = new Error(message); error.code = 'INVALID_PDF_ADVANCED_SEARCH'; return error; }
function plainObject(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function hasUnexpectedKey(keys, allowed) { return keys.some((key) => typeof key !== 'string' || !allowed.has(key)); }
function lacksRequiredField(descriptors, required) { return required.some((key) => !Object.hasOwn(descriptors, key)); }
function hasInvalidDescriptor(descriptors) { return Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true); }
function exact(value, required, optional = []) {
  if (!plainObject(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value); const allowed = new Set([...required, ...optional]);
  if (hasUnexpectedKey(keys, allowed)) throw invalid();
  if (lacksRequiredField(descriptors, required)) throw invalid();
  if (hasInvalidDescriptor(descriptors)) throw invalid();
  return descriptors;
}
function forbiddenTextPoint(point, allowSeparators) { return /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(point) && !(allowSeparators && '\t\n\f'.includes(point)); }
function text(value, label, allowSeparators = false) {
  if (typeof value !== 'string') throw invalid(`${label} must be NFC text without controls.`);
  if (value.normalize('NFC') !== value) throw invalid(`${label} must be NFC text without controls.`);
  if ([...value].some((point) => forbiddenTextPoint(point, allowSeparators))) throw invalid(`${label} must be NFC text without controls.`);
  return value;
}
function invalidPageCollection(pages) {
  if (!Array.isArray(pages)) return true;
  if (Object.getPrototypeOf(pages) !== Array.prototype) return true;
  return pages.length < 1 || pages.length > MAX_PAGES;
}
function invalidPageNumber(page, previous) {
  if (!Number.isSafeInteger(page)) return true;
  if (page < 1) return true;
  return page <= previous;
}
function normalizePages(pages) {
  if (invalidPageCollection(pages)) throw invalid();
  const normalizedPages = []; let previous = 0; let totalBytes = 0;
  for (const entry of pages) {
    const fields = exact(entry, ['page', 'text']); const page = fields.page.value; const content = text(fields.text.value, 'Extracted page text', true);
    if (invalidPageNumber(page, previous)) throw invalid('Extracted pages must be strictly ascending.');
    previous = page; totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_TEXT_BYTES) throw invalid('Extracted text exceeds the bounded UTF-8 limit.');
    normalizedPages.push(Object.freeze({ page, text: content }));
  }
  return Object.freeze(normalizedPages);
}
function validateIdentity(request) {
  if (request.profile.value !== PDF_ADVANCED_SEARCH_PROFILE) throw invalid();
  if (typeof request.sourceSha256.value !== 'string' || !SHA256.test(request.sourceSha256.value)) throw invalid();
}
function invalidQueryLength(length) { return length < 1 || length > MAX_QUERY_CHARS; }
function validateBooleanOptions(request) {
  if (typeof request.caseSensitive.value !== 'boolean') throw invalid();
  if (typeof request.wholeWord.value !== 'boolean') throw invalid();
}
function invalidContext(context) {
  if (!Number.isSafeInteger(context)) return true;
  if (context < 0) return true;
  return context > 200;
}
function invalidMaxResults(maxResults) {
  if (!Number.isSafeInteger(maxResults)) return true;
  if (maxResults < 1) return true;
  return maxResults > 1_000;
}
function validateNumericOptions(request) {
  if (invalidContext(request.context.value)) throw invalid();
  if (invalidMaxResults(request.maxResults.value)) throw invalid();
}
function wildcardLacksAnchor(query) { return [...query].every((character) => character === '*' || character === '?'); }
function validateSearchOptions(request, query) {
  const queryLength = [...query].length;
  if (invalidQueryLength(queryLength)) throw invalid();
  if (!MODES.has(request.mode.value)) throw invalid();
  validateBooleanOptions(request); validateNumericOptions(request);
  if (request.mode.value === 'wildcard' && wildcardLacksAnchor(query)) throw invalid('Wildcard queries must contain a literal anchor.');
}

export function normalizePdfAdvancedSearch(value) {
  const request = exact(value, ['profile', 'sourceSha256', 'pages', 'query', 'mode', 'caseSensitive', 'wholeWord', 'context', 'maxResults']);
  validateIdentity(request);
  const pages = normalizePages(request.pages.value); const query = text(request.query.value, 'Search query');
  validateSearchOptions(request, query);
  return Object.freeze({ profile: PDF_ADVANCED_SEARCH_PROFILE, sourceSha256: request.sourceSha256.value, pages, query, mode: request.mode.value, caseSensitive: request.caseSensitive.value, wholeWord: request.wholeWord.value, context: request.context.value, maxResults: request.maxResults.value });
}

export const normalizeAdvancedSearch = normalizePdfAdvancedSearch;
