import { createDeadline } from './workspace-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { isProxy } from 'node:util/types';
import { detectSensitiveTextPages } from './domains/redaction-domain.mjs';
import {
  PDF_SENSITIVE_PATTERN_LIMITATIONS,
  PDF_SENSITIVE_PATTERN_PROFILE,
  normalizePdfSensitivePatternRequest,
  validatePdfSensitivePatternResult,
} from '../../src/core/pdf-sensitive-pattern-contract.js';

const MAX_JOB_MS = 120_000;
const MAX_PAGES = 200;
const MAX_PAGE_TEXT_BYTES = 100_000;
const MAX_MATCHES = 500;

function host(code, message, status = 502, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

function abort(signal) {
  if (signal?.aborted) throw host('JOB_CANCELLED', 'Sensitive-pattern scanning was cancelled.', 499);
}

function exactPage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return null;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !Object.hasOwn(descriptors, 'page') || !Object.hasOwn(descriptors, 'text')
    || keys.some((key) => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) return null;
  return { page: descriptors.page.value, text: descriptors.text.value };
}

function boundedPages(value, pageCount) {
  if (!Array.isArray(value) || isProxy(value) || value.length !== pageCount || value.length < 1 || value.length > MAX_PAGES) {
    throw host('PDF_SENSITIVE_PATTERN_ENGINE_INVALID', 'Text extraction did not return the bounded page inventory.', 502);
  }
  const pages = [];
  let previous = 0;
  for (const entry of value) {
    const page = exactPage(entry);
    if (!page || !Number.isSafeInteger(page.page) || page.page < 1 || page.page <= previous
      || page.page > pageCount || typeof page.text !== 'string') {
      throw host('PDF_SENSITIVE_PATTERN_ENGINE_INVALID', 'Text extraction returned a malformed page record.', 502);
    }
    if (Buffer.byteLength(page.text, 'utf8') > MAX_PAGE_TEXT_BYTES) {
      throw host('PDF_SENSITIVE_PATTERN_TEXT_LIMIT', 'Extracted page text exceeded the bounded UTF-8 limit.', 422);
    }
    previous = page.page;
    pages.push(Object.freeze(page));
  }
  return Object.freeze(pages);
}

function boundedMatches(value, pageCount) {
  if (!Array.isArray(value) || isProxy(value)) {
    throw host('PDF_SENSITIVE_PATTERN_OUTPUT_INVALID', 'The sensitive-pattern detector returned an invalid match list.', 502);
  }
  const matches = value.slice(0, MAX_MATCHES).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || isProxy(entry)) {
      throw host('PDF_SENSITIVE_PATTERN_OUTPUT_INVALID', 'The sensitive-pattern detector returned an invalid match.', 502);
    }
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    const fields = ['id', 'pageNumber', 'textRange', 'kind', 'label'];
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value'))) {
      throw host('PDF_SENSITIVE_PATTERN_OUTPUT_INVALID', 'The sensitive-pattern detector returned an invalid match.', 502);
    }
    const id = descriptors.id?.value;
    const page = descriptors.pageNumber?.value;
    const range = descriptors.textRange?.value;
    const kind = descriptors.kind?.value;
    const label = descriptors.label?.value;
    const rangeDescriptors = range && typeof range === 'object' && !Array.isArray(range) && !isProxy(range)
      ? Object.getOwnPropertyDescriptors(range) : null;
    if (!rangeDescriptors || Reflect.ownKeys(rangeDescriptors).length !== 2
      || !Object.hasOwn(rangeDescriptors, 'start') || !Object.hasOwn(rangeDescriptors, 'end')
      || Object.values(rangeDescriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)
      || typeof id !== 'string' || id.length < 1 || id.length > 128 || !Number.isSafeInteger(page)
      || page < 1 || page > pageCount || !Number.isSafeInteger(rangeDescriptors.start.value)
      || !Number.isSafeInteger(rangeDescriptors.end.value) || rangeDescriptors.start.value < 0
      || rangeDescriptors.end.value <= rangeDescriptors.start.value || typeof kind !== 'string' || typeof label !== 'string') {
      throw host('PDF_SENSITIVE_PATTERN_OUTPUT_INVALID', 'The sensitive-pattern detector returned an invalid match.', 502);
    }
    return { id, page, start: rangeDescriptors.start.value, end: rangeDescriptors.end.value, kind, label };
  });
  matches.sort((left, right) => left.page - right.page || left.start - right.start || left.end - right.end);
  return Object.freeze(matches.map((match, index) => Object.freeze({ ...match, id: `match-${index + 1}` })));
}

export class PdfSensitivePatternService {
  #store;
  #inspection;
  #detector;

  constructor({ store, inspection, detector = detectSensitiveTextPages } = {}) {
    if (!store || typeof store.getDocument !== 'function' || typeof store.verifySource !== 'function') {
      throw new TypeError('PdfSensitivePatternService requires a DocumentStore-compatible store.');
    }
    if (!inspection || typeof inspection.inspect !== 'function' || typeof inspection.extractText !== 'function') {
      throw new TypeError('PdfSensitivePatternService requires a PDF inspection facade.');
    }
    if (typeof detector !== 'function') throw new TypeError('detector must be a function.');
    this.#store = store;
    this.#inspection = inspection;
    this.#detector = detector;
  }

  async find(documentId, value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    abort(signal);
    let request;
    try {
      request = normalizePdfSensitivePatternRequest(value);
    } catch (error) {
      throw host('PDF_SENSITIVE_PATTERN_REQUEST_INVALID', 'Sensitive-pattern scan options are invalid.', 400, error);
    }
    const source = this.#store.getDocument(documentId);
    const sourceSha256 = source?.sha256;
    if (!/^[0-9a-f]{64}$/u.test(String(sourceSha256 ?? '')) || request.sourceSha256 !== sourceSha256) {
      throw host('SOURCE_VERSION_MISMATCH', 'The sensitive-pattern source digest does not match the current document.', 409);
    }
    const deadline = createDeadline(signal, MAX_JOB_MS);
    try {
      await this.#store.verifySource(documentId);
      abort(deadline.signal);
      const inspection = await this.#inspection.inspect(documentId, { signal: deadline.signal });
      const pageCount = inspection?.pageCount;
      if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) {
        throw host('PDF_SENSITIVE_PATTERN_PAGE_LIMIT', 'The inspected PDF page count exceeds the bounded scan limit.', 422);
      }
      const extracted = boundedPages(await this.#inspection.extractText(documentId, pageCount, { signal: deadline.signal }), pageCount);
      abort(deadline.signal);
      const detected = this.#detector(extracted, { customPatterns: request.customPatterns });
      const matches = boundedMatches(detected, pageCount);
      await this.#store.verifySource(documentId);
      abort(deadline.signal);
      const current = this.#store.getDocument(documentId);
      if (!current || current.sha256 !== sourceSha256) {
        throw host('SOURCE_VERSION_MISMATCH', 'The sensitive-pattern source changed during scanning.', 409);
      }
      const result = Object.freeze({
        kind: 'pdf-sensitive-pattern-scan',
        profile: PDF_SENSITIVE_PATTERN_PROFILE,
        documentId,
        sourceSha256,
        pageCount,
        matches,
        matchCount: matches.length,
        truncated: matches.length >= MAX_MATCHES,
        evidence: Object.freeze({ sourceDigestReverified: true, sourceUnchanged: true, localOnly: true, textReturned: false, pathsReturned: false, bounded: true }),
        limitations: PDF_SENSITIVE_PATTERN_LIMITATIONS,
      });
      return validatePdfSensitivePatternResult(result, { documentId, sourceSha256, request });
    } catch (error) {
      if (deadline.timedOut) throw host('PDF_SENSITIVE_PATTERN_TIMEOUT', 'Sensitive-pattern scanning exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted) throw host('JOB_CANCELLED', 'Sensitive-pattern scanning was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      throw host('PDF_SENSITIVE_PATTERN_ENGINE_INVALID', 'The PDF inspection engine returned malformed sensitive-pattern evidence.', 502);
    } finally {
      deadline.dispose();
    }
  }
}
