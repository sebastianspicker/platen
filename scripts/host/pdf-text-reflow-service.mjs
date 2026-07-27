import { HostError } from './host-error.mjs';
import { createDeadline } from './workspace-job-runtime.mjs';
import { normalizePdfTextReflowRequest, PDF_TEXT_REFLOW_PROFILE } from './pdf-text-reflow-contract.mjs';
import { cleanupPdfTextReflowJob, MAX_PDF_TEXT_REFLOW_JOB_MS, MAX_PDF_TEXT_REFLOW_SOURCE_BYTES, runPdfTextReflowJob } from './pdf-text-reflow-job.mjs';
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'getArtifact', 'deleteArtifact']);
function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
export class PdfTextReflowService {
  #store;
  constructor({ store } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function')) throw new TypeError('PdfTextReflowService requires a DocumentStore-compatible store.'); this.#store = store; }
  async reflow(documentId, value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.'); let request; try { request = normalizePdfTextReflowRequest(value); } catch (error) { host('PDF_TEXT_REFLOW_OPTIONS_INVALID', 'The PDF text-reflow request is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId); if (request.sourceSha256 !== source.sha256) host('SOURCE_VERSION_MISMATCH', 'The text-reflow source digest does not match the current document.', 409); if (!Number.isSafeInteger(source.size) || source.size < 64 || source.size > MAX_PDF_TEXT_REFLOW_SOURCE_BYTES) host('PDF_TEXT_REFLOW_INPUT_TOO_LARGE', 'The text-reflow source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_TEXT_REFLOW_JOB_MS); const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
    try { return await runPdfTextReflowJob({ store: this.#store, documentId, source, request, deadline, lifecycle }); }
    catch (error) { if (deadline.timedOut) host('PDF_TEXT_REFLOW_TIMEOUT', 'PDF text reflow exceeded its deadline.', 504, error); if (signal?.aborted || error?.code === 'JOB_CANCELLED') host('JOB_CANCELLED', 'PDF text reflow was cancelled.', 499, error); if (error instanceof HostError) throw error; if (error?.code === 'UNSUPPORTED_PDF_TEXT_REFLOW') host('PDF_TEXT_REFLOW_SOURCE_UNSUPPORTED', 'The source is outside the bounded fixed-slot text-reflow subset.', 422, error); if (error?.code === 'INVALID_PDF_TEXT_REFLOW_OUTPUT') host('PDF_TEXT_REFLOW_OUTPUT_INVALID', 'Independent inspection rejected the text-reflow output.', 502, error); host('PDF_TEXT_REFLOW_FAILED', 'The local host could not create a verified text-reflow artifact.', 502, error); }
    finally { deadline.dispose(); await cleanupPdfTextReflowJob({ store: this.#store, lifecycle }); }
  }
  async edit(documentId, value, options = {}) { return this.reflow(documentId, value, options); }
}
export const TextReflowService = PdfTextReflowService;
export { PDF_TEXT_REFLOW_PROFILE };
