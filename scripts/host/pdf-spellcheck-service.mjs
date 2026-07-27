import { createDeadline } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { types as nodeTypes } from 'node:util';
import { PDF_SPELLCHECK_PROFILE, normalizePdfSpellcheckRequest } from './pdf-spellcheck-contract.mjs';
import { runPdfSpellcheckJob } from './pdf-spellcheck-job.mjs';

const MAX_JOB_MS = 120_000; const SAFE_ERRORS = new Set(['PDF_SPELLCHECK_PAGE_LIMIT', 'PDF_SPELLCHECK_TEXT_LIMIT', 'PDF_SPELLCHECK_ENGINE_INVALID', 'PDF_SPELLCHECK_OUTPUT_INVALID', 'PDF_SPELLCHECK_TIMEOUT', 'INVALID_PDF_SPELLCHECK']);
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function requestInput(value, sourceSha256) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Spellcheck options are invalid.');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value); const allowed = new Set(['dictionary', 'pages']);
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))
      || keys.length !== allowed.size || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw new Error('Spellcheck options are invalid.');
    return { profile: PDF_SPELLCHECK_PROFILE, sourceSha256, dictionary: descriptors.dictionary.value, pages: descriptors.pages.value };
  } catch (error) {
    error.code = 'INVALID_PDF_SPELLCHECK'; throw error;
  }
}

export class PdfSpellcheckService {
  #store; #inspection; #core;
  constructor({ store, inspection, core } = {}) { if (!store || typeof store.getDocument !== 'function' || typeof store.verifySource !== 'function') throw new TypeError('PdfSpellcheckService requires a DocumentStore-compatible store.'); if (!inspection || typeof inspection.inspect !== 'function' || typeof inspection.extractText !== 'function') throw new TypeError('PdfSpellcheckService requires a PDF inspection facade.'); if (core !== undefined && typeof core.buildPdfSpellcheckReport !== 'function') throw new TypeError('PdfSpellcheckService requires the spellcheck report core API.'); this.#store = store; this.#inspection = inspection; this.#core = core; }
  async check(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const source = this.#store.getDocument(documentId); if (!source || typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(source.sha256) || sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The spellcheck source digest does not match the current document.', 409);
    let request;
    try {
      request = normalizePdfSpellcheckRequest(requestInput(value, source.sha256));
    } catch (error) {
      if (error?.code === 'INVALID_PDF_SPELLCHECK') throw host('INVALID_PDF_SPELLCHECK', 'Spellcheck options are invalid.', 400, error);
      throw error;
    }
    const deadline = createDeadline(signal, MAX_JOB_MS);
    try {
      const report = await runPdfSpellcheckJob({ store: this.#store, inspection: this.#inspection, core: this.#core, documentId, request, signal: deadline.signal });
      return Object.freeze({ kind: 'pdf-spellcheck-review', report, evidence: Object.freeze({ sourceDigestReverified: true, extractionBound: true, contentChanged: false, linguisticCorrectnessClaim: false, localOnly: true }), limitations: Object.freeze(['This review checks extracted text against only the caller-provided deterministic local dictionary.', 'Dictionary misses are review candidates, not proof of spelling errors or linguistic incorrectness.', 'The PDF bytes and content are never modified by this operation.']) });
    } catch (error) {
      if (deadline.timedOut) throw host('PDF_SPELLCHECK_TIMEOUT', 'Spellcheck exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted) throw host('JOB_CANCELLED', 'Spellcheck was cancelled.', 499, error);
      if (error?.code === 'SOURCE_VERSION_MISMATCH') throw host('SOURCE_VERSION_MISMATCH', 'The spellcheck source changed during review.', 409, error);
      if (error instanceof HostError && (SAFE_ERRORS.has(error.code) || error.code === 'SOURCE_VERSION_MISMATCH')) throw error;
      if (SAFE_ERRORS.has(error?.code)) throw host(error.code, 'Spellcheck evidence or options were invalid.', error.code === 'INVALID_PDF_SPELLCHECK' ? 400 : 502, error);
      throw host('PDF_SPELLCHECK_ENGINE_FAILED', 'The PDF inspection engine could not produce bounded spellcheck evidence.', 502);
    } finally { deadline.dispose(); }
  }
}
