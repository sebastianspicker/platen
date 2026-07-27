import { createDeadline } from './workspace-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { cleanupHiddenDataSanitizationJob, MAX_PDF_HIDDEN_DATA_SANITIZATION_JOB_MS, runHiddenDataSanitizationJob } from './pdf-hidden-data-sanitization-job.mjs';
import { MAX_PDF_HIDDEN_DATA_SANITIZER_SOURCE_BYTES } from './pdf-hidden-data-sanitizer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const STORE_METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }

export class PdfHiddenDataSanitizationService {
  #store;
  constructor({ store } = {}) { if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) throw new TypeError('PdfHiddenDataSanitizationService requires a DocumentStore-compatible store.'); this.#store = store; }

  async sanitize(documentId, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    if (!SHA256.test(String(sourceSha256 ?? ''))) throw host('INVALID_HIDDEN_DATA_SANITIZATION_OPTIONS', 'Hidden-data sanitization requires a lowercase source SHA-256 digest.', 400);
    const source = this.#store.getDocument(documentId);
    if (sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The hidden-data sanitizer source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_PDF_HIDDEN_DATA_SANITIZER_SOURCE_BYTES) throw host('HIDDEN_DATA_SANITIZATION_INPUT_TOO_LARGE', 'The hidden-data sanitizer source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_HIDDEN_DATA_SANITIZATION_JOB_MS); const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
    try { return await runHiddenDataSanitizationJob({ store: this.#store, documentId, source, request: { sourceSha256 }, deadline, lifecycle }); }
    catch (error) {
      if (deadline.timedOut) throw host('HIDDEN_DATA_SANITIZATION_TIMEOUT', 'Hidden-data sanitization exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted) throw host('JOB_CANCELLED', 'Hidden-data sanitization was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_PDF_HIDDEN_DATA_SANITIZER_SOURCE') throw host('HIDDEN_DATA_SANITIZATION_SOURCE_UNSUPPORTED', 'The PDF is outside the bounded hidden-data sanitizer subset.', 422, error);
      if (error?.code === 'INVALID_PDF_HIDDEN_DATA_SANITIZER_OUTPUT') throw host('HIDDEN_DATA_SANITIZATION_OUTPUT_INVALID', 'Independent hidden-data residue inspection rejected the output.', 502, error);
      throw host('HIDDEN_DATA_SANITIZATION_FAILED', 'The local host could not create a verified hidden-data-sanitized PDF.', 502, error);
    } finally { deadline.dispose(); await cleanupHiddenDataSanitizationJob({ store: this.#store, lifecycle }); }
  }
}

export const HiddenDataSanitizationService = PdfHiddenDataSanitizationService;
