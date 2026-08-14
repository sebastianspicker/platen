import { HostError } from './host-error.mjs';
import { createDeadline } from './workspace-job-runtime.mjs';
import { analyzePdfFormJavaScript } from './pdf-form-javascript-analyzer.mjs';
import { normalizePdfFormJavaScriptInventoryRequest, PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS, PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE } from './pdf-form-javascript-contract.mjs';
import { cleanupPdfFormJavaScriptInventoryJob, MAX_PDF_FORM_JAVASCRIPT_JOB_MS, runPdfFormJavaScriptInventoryJob } from './pdf-form-javascript-job.mjs';

const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob']);
function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
export class PdfFormJavaScriptInventoryService {
  #store;
  #analyzer;
  constructor({ store, analyzer = analyzePdfFormJavaScript } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function') || typeof analyzer !== 'function') throw new TypeError('PdfFormJavaScriptInventoryService requires a DocumentStore-compatible store and analyzer.'); this.#store = store; this.#analyzer = analyzer; }
  async inspect(documentId, value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.'); let request; try { request = normalizePdfFormJavaScriptInventoryRequest(value); } catch (error) { host('PDF_FORM_JAVASCRIPT_OPTIONS_INVALID', 'The form JavaScript inventory request is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId); if (request.sourceSha256 !== source.sha256) host('SOURCE_VERSION_MISMATCH', 'The form JavaScript source digest does not match the current document.', 409); if (!Number.isSafeInteger(source.size) || source.size < 32 || source.size > PDF_FORM_JAVASCRIPT_INVENTORY_LIMITS.maxSourceBytes) host('PDF_FORM_JAVASCRIPT_INPUT_TOO_LARGE', 'The form JavaScript source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_FORM_JAVASCRIPT_JOB_MS); const lifecycle = { workspace: null, completed: false };
    try { return await runPdfFormJavaScriptInventoryJob({ store: this.#store, analyzer: this.#analyzer, documentId, source, request, deadline, lifecycle }); }
    catch (error) { if (deadline.timedOut) host('PDF_FORM_JAVASCRIPT_TIMEOUT', 'Form JavaScript inventory exceeded its deadline.', 504, error); if (signal?.aborted || error?.code === 'JOB_CANCELLED') host('JOB_CANCELLED', 'Form JavaScript inventory was cancelled.', 499, error); if (error instanceof HostError) throw error; if (error?.code === 'UNSUPPORTED_PDF_FORM_JAVASCRIPT_INVENTORY_SOURCE') host('PDF_FORM_JAVASCRIPT_SOURCE_UNSUPPORTED', 'The source is outside the bounded static form JavaScript inventory subset.', 422, error); if (error?.code === 'INVALID_PDF_FORM_JAVASCRIPT_INVENTORY_OUTPUT') host('PDF_FORM_JAVASCRIPT_OUTPUT_INVALID', 'Independent inspection rejected the form JavaScript inventory result.', 502, error); host('PDF_FORM_JAVASCRIPT_FAILED', 'The local host could not produce a verified form JavaScript inventory.', 502, error); }
    finally { deadline.dispose(); await cleanupPdfFormJavaScriptInventoryJob({ store: this.#store, lifecycle }); }
  }
  async inventory(documentId, value, options = {}) { return this.inspect(documentId, value, options); }
}
export const FormJavaScriptInventoryService = PdfFormJavaScriptInventoryService;
export { PDF_FORM_JAVASCRIPT_INVENTORY_PROFILE };
