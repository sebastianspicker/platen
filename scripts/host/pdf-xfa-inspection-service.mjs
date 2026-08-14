import { HostError } from './host-error.mjs';
import { createDeadline } from './workspace-job-runtime.mjs';
import { analyzePdfXfaPresence } from './pdf-xfa-inspection-analyzer.mjs';
import { normalizePdfXfaInspectionRequest, PDF_XFA_INSPECTION_LIMITS, PDF_XFA_INSPECTION_PROFILE } from './pdf-xfa-inspection-contract.mjs';
import { cleanupPdfXfaInspectionJob, MAX_PDF_XFA_INSPECTION_JOB_MS, runPdfXfaInspectionJob } from './pdf-xfa-inspection-job.mjs';

const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob']);
function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }

export class PdfXfaInspectionService {
  #store;
  #analyzer;
  constructor({ store, analyzer = analyzePdfXfaPresence } = {}) {
    if (!store || METHODS.some((method) => typeof store[method] !== 'function') || typeof analyzer !== 'function') throw new TypeError('PdfXfaInspectionService requires a DocumentStore-compatible store and analyzer.');
    this.#store = store;
    this.#analyzer = analyzer;
  }
  async inspect(documentId, value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request;
    try { request = normalizePdfXfaInspectionRequest(value); } catch (error) { host('PDF_XFA_INSPECTION_OPTIONS_INVALID', 'The XFA inspection request is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId);
    if (request.sourceSha256 !== source.sha256) host('SOURCE_VERSION_MISMATCH', 'The XFA inspection source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 32 || source.size > PDF_XFA_INSPECTION_LIMITS.maxSourceBytes) host('PDF_XFA_INSPECTION_INPUT_TOO_LARGE', 'The XFA inspection source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_XFA_INSPECTION_JOB_MS);
    const lifecycle = { workspace: null, completed: false };
    try { return await runPdfXfaInspectionJob({ store: this.#store, analyzer: this.#analyzer, documentId, source, request, deadline, lifecycle }); }
    catch (error) {
      if (deadline.timedOut) host('PDF_XFA_INSPECTION_TIMEOUT', 'XFA inspection exceeded its deadline.', 504, error);
      if (signal?.aborted || error?.code === 'JOB_CANCELLED') host('JOB_CANCELLED', 'XFA inspection was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_PDF_XFA_INSPECTION_SOURCE') host('PDF_XFA_INSPECTION_SOURCE_UNSUPPORTED', 'The source is outside the bounded XFA inspection subset.', 422, error);
      if (error?.code === 'INVALID_PDF_XFA_INSPECTION_OUTPUT') host('PDF_XFA_INSPECTION_OUTPUT_INVALID', 'Independent inspection rejected the XFA inspection result.', 502, error);
      host('PDF_XFA_INSPECTION_FAILED', 'The local host could not produce a verified XFA inspection.', 502, error);
    } finally { deadline.dispose(); await cleanupPdfXfaInspectionJob({ store: this.#store, lifecycle }); }
  }
}

export const XfaInspectionService = PdfXfaInspectionService;
export { PDF_XFA_INSPECTION_PROFILE };
