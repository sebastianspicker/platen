import { createDeadline } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { PDF_ADVANCED_SEARCH_PROFILE } from './pdf-advanced-search-contract.mjs';
import { searchPdfAdvancedText } from './pdf-advanced-search.mjs';

const MAX_JOB_MS = 120_000; const MAX_PAGES = 1_000; const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const OPTION_KEYS = Object.freeze(['query', 'mode', 'caseSensitive', 'wholeWord', 'context', 'maxResults']);
const SAFE_ERRORS = new Set(['SOURCE_VERSION_MISMATCH', 'PDF_ADVANCED_SEARCH_PAGE_LIMIT', 'PDF_ADVANCED_SEARCH_ENGINE_INVALID', 'PDF_ADVANCED_SEARCH_OUTPUT_INVALID', 'PDF_ADVANCED_SEARCH_OPTIONS_INVALID']);
const CORE = Object.freeze({ searchPdfAdvancedText });
const LIMITATIONS = Object.freeze(['Search is over extracted text only; it is not authoritative for layout, comments, PDF objects, or OCR.', 'This local operation searches one immutable document at a time and does not disambiguate or navigate by page labels.']);
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function exactOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw host('PDF_ADVANCED_SEARCH_OPTIONS_INVALID', 'Advanced-search options are invalid.', 400);
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value); if (keys.length !== OPTION_KEYS.length || keys.some((key) => typeof key !== 'string' || !OPTION_KEYS.includes(key)) || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw host('PDF_ADVANCED_SEARCH_OPTIONS_INVALID', 'Advanced-search options are invalid.', 400);
  return Object.freeze(Object.fromEntries(OPTION_KEYS.map((key) => [key, descriptors[key].value])));
}
function records(value, pageCount) {
  if (!Array.isArray(value) || value.length !== pageCount || value.length > MAX_PAGES) throw host('PDF_ADVANCED_SEARCH_ENGINE_INVALID', 'Text extraction did not return the bounded page inventory.', 502);
  const result = []; let previous = 0; let bytes = 0;
  for (const entry of value) {
    const descriptors = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.getOwnPropertyDescriptors(entry) : null;
    const invalid = !descriptors || Reflect.ownKeys(descriptors).length !== 2
      || !Object.hasOwn(descriptors, 'page') || !Object.hasOwn(descriptors, 'text')
      || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true);
    if (invalid) throw host('PDF_ADVANCED_SEARCH_ENGINE_INVALID', 'Text extraction returned an invalid page record.', 502);
    const page = descriptors.page.value; const text = descriptors.text.value;
    if (!Number.isSafeInteger(page) || page < 1 || page <= previous || typeof text !== 'string') throw host('PDF_ADVANCED_SEARCH_ENGINE_INVALID', 'Text extraction returned an invalid page record.', 502);
    previous = page; bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_TEXT_BYTES) throw host('PDF_ADVANCED_SEARCH_ENGINE_INVALID', 'Extracted text exceeded the bounded search limit.', 422);
    result.push(Object.freeze({ page, text }));
  }
  return Object.freeze(result);
}

export class PdfAdvancedSearchService {
  #store; #inspection; #core;
  constructor({ store, inspection, core = CORE } = {}) {
    if (!store || typeof store.getDocument !== 'function' || typeof store.verifySource !== 'function') throw new TypeError('PdfAdvancedSearchService requires a DocumentStore-compatible store.');
    if (!inspection || typeof inspection.inspect !== 'function' || typeof inspection.extractText !== 'function') throw new TypeError('PdfAdvancedSearchService requires a PDF inspection facade.');
    if (!core || typeof core.searchPdfAdvancedText !== 'function') throw new TypeError('PdfAdvancedSearchService requires the advanced-search core API.');
    this.#store = store; this.#inspection = inspection; this.#core = core;
  }
  async search(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.'); const options = exactOptions(value); const source = this.#store.getDocument(documentId);
    if (!/^[0-9a-f]{64}$/u.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The advanced-search source digest does not match the current document.', 409);
    const deadline = createDeadline(signal, MAX_JOB_MS);
    try {
      await this.#store.verifySource(documentId); if (deadline.signal.aborted) throw deadline.signal.reason ?? new Error('Search cancelled.');
      const inspection = await this.#inspection.inspect(documentId, { signal: deadline.signal }); const pageCount = inspection?.pageCount;
      if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) throw host('PDF_ADVANCED_SEARCH_PAGE_LIMIT', 'The inspected PDF page count exceeds the bounded search limit.', 422);
      const extracted = records(await this.#inspection.extractText(documentId, pageCount, { signal: deadline.signal }), pageCount);
      const request = Object.freeze({ profile: PDF_ADVANCED_SEARCH_PROFILE, sourceSha256: source.sha256, pages: extracted, ...options }); const result = this.#core.searchPdfAdvancedText(request); if (result?.sourceSha256 !== source.sha256) throw host('PDF_ADVANCED_SEARCH_OUTPUT_INVALID', 'Advanced-search evidence was not bound to the current source.', 502);
      await this.#store.verifySource(documentId); if (deadline.signal.aborted) throw deadline.signal.reason ?? new Error('Search cancelled.');
      return Object.freeze({ ...result, limitations: LIMITATIONS });
    } catch (error) {
      if (deadline.timedOut) throw host('PDF_ADVANCED_SEARCH_TIMEOUT', 'Advanced search exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted) throw host('JOB_CANCELLED', 'Advanced search was cancelled.', 499, error);
      if (error instanceof HostError && SAFE_ERRORS.has(error.code)) throw error;
      if (error?.code === 'INVALID_PDF_ADVANCED_SEARCH') throw host('PDF_ADVANCED_SEARCH_OPTIONS_INVALID', 'Advanced-search options or extracted text are invalid.', 400, error);
      if (error?.code === 'UNSUPPORTED_PDF_ADVANCED_SEARCH') throw host('PDF_ADVANCED_SEARCH_UNSUPPORTED', 'The advanced-search request is outside the bounded extracted-text subset.', 422, error);
      throw host('PDF_ADVANCED_SEARCH_ENGINE_FAILED', 'The PDF inspection engine could not produce bounded extracted-text evidence.', 502);
    } finally { deadline.dispose(); }
  }
}
