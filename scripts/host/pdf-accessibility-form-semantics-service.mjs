import { HostError } from './host-error.mjs';
import { createDeadline } from './workspace-job-runtime.mjs';
import { normalizePdfAccessibilityFormSemantics, PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE } from './pdf-accessibility-form-semantics-contract.mjs';
import { cleanupPdfAccessibilityFormSemanticsJob, MAX_PDF_ACCESSIBILITY_FORM_SEMANTICS_JOB_MS, MAX_PDF_ACCESSIBILITY_FORM_SEMANTICS_SOURCE_BYTES, runPdfAccessibilityFormSemanticsJob } from './pdf-accessibility-form-semantics-job.mjs';

const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
export class PdfAccessibilityFormSemanticsService {
  #store;
  constructor({ store } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function')) throw new TypeError('PdfAccessibilityFormSemanticsService requires a DocumentStore-compatible store.'); this.#store = store; }
  async repair(documentId, value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request; try { request = normalizePdfAccessibilityFormSemantics(value); } catch (error) { host('INVALID_PDF_ACCESSIBILITY_FORM_SEMANTICS_OPTIONS', 'The accessible form semantics request is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId); if (request.sourceSha256 !== source.sha256) host('SOURCE_VERSION_MISMATCH', 'The accessible form semantics source digest does not match the current document.', 409); if (!Number.isSafeInteger(source.size) || source.size < 32 || source.size > MAX_PDF_ACCESSIBILITY_FORM_SEMANTICS_SOURCE_BYTES) host('PDF_ACCESSIBILITY_FORM_SEMANTICS_INPUT_TOO_LARGE', 'The accessible form semantics source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_ACCESSIBILITY_FORM_SEMANTICS_JOB_MS); const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
    try { return await runPdfAccessibilityFormSemanticsJob({ store: this.#store, documentId, source, request, deadline, lifecycle }); }
    catch (error) { if (deadline.timedOut) host('PDF_ACCESSIBILITY_FORM_SEMANTICS_TIMEOUT', 'Accessible form semantics processing exceeded its deadline.', 504, error); if (signal?.aborted || error?.code === 'JOB_CANCELLED') host('JOB_CANCELLED', 'Accessible form semantics processing was cancelled.', 499, error); if (error instanceof HostError) throw error; if (error?.code === 'UNSUPPORTED_PDF_ACCESSIBILITY_FORM_SEMANTICS') host('PDF_ACCESSIBILITY_FORM_SEMANTICS_SOURCE_UNSUPPORTED', 'The source is outside the bounded passive accessible-form semantics subset.', 422, error); if (error?.code === 'INVALID_PDF_ACCESSIBILITY_FORM_SEMANTICS_OUTPUT') host('PDF_ACCESSIBILITY_FORM_SEMANTICS_OUTPUT_INVALID', 'Independent inspection rejected the output.', 502, error); host('PDF_ACCESSIBILITY_FORM_SEMANTICS_FAILED', 'The local host could not create a verified accessible-form semantics artifact.', 502, error); }
    finally { deadline.dispose(); await cleanupPdfAccessibilityFormSemanticsJob({ store: this.#store, lifecycle }); }
  }
  async update(documentId, value, options = {}) { return this.repair(documentId, value, options); }
}
export const AccessibilityFormSemanticsService = PdfAccessibilityFormSemanticsService;
export { PDF_ACCESSIBILITY_FORM_SEMANTICS_PROFILE };
