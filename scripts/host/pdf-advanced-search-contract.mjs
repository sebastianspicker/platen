export const PDF_ADVANCED_SEARCH_PROFILE = 'local-pdf-advanced-search-v1';
export const ADVANCED_SEARCH_PROFILE = PDF_ADVANCED_SEARCH_PROFILE;

const SHA256 = /^[0-9a-f]{64}$/u;
const MODES = new Set(['literal', 'wildcard']);
const MAX_PAGES = 1_000;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_QUERY_CHARS = 128;

function invalid(message = 'PDF advanced-search request is invalid.') { const error = new Error(message); error.code = 'INVALID_PDF_ADVANCED_SEARCH'; return error; }
function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value); const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key)) || required.some((key) => !Object.hasOwn(descriptors, key)) || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw invalid();
  return descriptors;
}
function text(value, label, allowSeparators = false) {
  if (typeof value !== 'string' || value.normalize('NFC') !== value || [...value].some((point) => /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(point) && !(allowSeparators && '\t\n\f'.includes(point)))) throw invalid(`${label} must be NFC text without controls.`);
  return value;
}

export function normalizePdfAdvancedSearch(value) {
  const request = exact(value, ['profile', 'sourceSha256', 'pages', 'query', 'mode', 'caseSensitive', 'wholeWord', 'context', 'maxResults']);
  if (request.profile.value !== PDF_ADVANCED_SEARCH_PROFILE || typeof request.sourceSha256.value !== 'string' || !SHA256.test(request.sourceSha256.value)) throw invalid();
  const pages = request.pages.value; if (!Array.isArray(pages) || Object.getPrototypeOf(pages) !== Array.prototype || pages.length < 1 || pages.length > MAX_PAGES) throw invalid();
  const normalizedPages = []; let previous = 0; let totalBytes = 0;
  for (const entry of pages) { const fields = exact(entry, ['page', 'text']); const page = fields.page.value; const content = text(fields.text.value, 'Extracted page text', true); if (!Number.isSafeInteger(page) || page < 1 || page <= previous) throw invalid('Extracted pages must be strictly ascending.'); previous = page; totalBytes += Buffer.byteLength(content, 'utf8'); if (totalBytes > MAX_TEXT_BYTES) throw invalid('Extracted text exceeds the bounded UTF-8 limit.'); normalizedPages.push(Object.freeze({ page, text: content })); }
  const query = text(request.query.value, 'Search query'); if ([...query].length < 1 || [...query].length > MAX_QUERY_CHARS || !MODES.has(request.mode.value) || typeof request.caseSensitive.value !== 'boolean' || typeof request.wholeWord.value !== 'boolean' || !Number.isSafeInteger(request.context.value) || request.context.value < 0 || request.context.value > 200 || !Number.isSafeInteger(request.maxResults.value) || request.maxResults.value < 1 || request.maxResults.value > 1_000) throw invalid();
  if (request.mode.value === 'wildcard' && [...query].every((character) => character === '*' || character === '?')) throw invalid('Wildcard queries must contain a literal anchor.');
  return Object.freeze({ profile: PDF_ADVANCED_SEARCH_PROFILE, sourceSha256: request.sourceSha256.value, pages: Object.freeze(normalizedPages), query, mode: request.mode.value, caseSensitive: request.caseSensitive.value, wholeWord: request.wholeWord.value, context: request.context.value, maxResults: request.maxResults.value });
}

export const normalizeAdvancedSearch = normalizePdfAdvancedSearch;
