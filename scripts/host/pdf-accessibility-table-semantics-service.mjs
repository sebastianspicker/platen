import { HostError } from './host-error.mjs';
import { createDeadline } from './workspace-job-runtime.mjs';
import { normalizePdfAccessibilityTableSemantics, PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE } from './pdf-accessibility-table-semantics-contract.mjs';
import { cleanupPdfAccessibilityTableSemanticsJob, MAX_PDF_ACCESSIBILITY_TABLE_SEMANTICS_JOB_MS, MAX_PDF_ACCESSIBILITY_TABLE_SEMANTICS_SOURCE_BYTES, runPdfAccessibilityTableSemanticsJob } from './pdf-accessibility-table-semantics-job.mjs';
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'getArtifact', 'deleteArtifact']);
function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
export class PdfAccessibilityTableSemanticsService {
  #store;
  constructor({ store } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function')) throw new TypeError('PdfAccessibilityTableSemanticsService requires a DocumentStore-compatible store.'); this.#store = store; }
  async repair(documentId, value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request; try { request = normalizePdfAccessibilityTableSemantics(value); } catch (error) { host('INVALID_PDF_ACCESSIBILITY_TABLE_SEMANTICS_OPTIONS', 'The accessible table semantics request is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId); if (request.sourceSha256 !== source.sha256) host('SOURCE_VERSION_MISMATCH', 'The table semantics source digest does not match the current document.', 409); if (!Number.isSafeInteger(source.size) || source.size < 32 || source.size > MAX_PDF_ACCESSIBILITY_TABLE_SEMANTICS_SOURCE_BYTES) host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_INPUT_TOO_LARGE', 'The table semantics source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_ACCESSIBILITY_TABLE_SEMANTICS_JOB_MS); const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
    try { return await runPdfAccessibilityTableSemanticsJob({ store: this.#store, documentId, source, request, deadline, lifecycle }); }
    catch (error) { if (deadline.timedOut) host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_TIMEOUT', 'Table semantics processing exceeded its deadline.', 504, error); if (signal?.aborted || error?.code === 'JOB_CANCELLED') host('JOB_CANCELLED', 'Table semantics processing was cancelled.', 499, error); if (error instanceof HostError) throw error; if (error?.code === 'UNSUPPORTED_PDF_ACCESSIBILITY_TABLE_SEMANTICS') host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_SOURCE_UNSUPPORTED', 'The source is outside the bounded table semantics subset.', 422, error); if (error?.code === 'INVALID_PDF_ACCESSIBILITY_TABLE_SEMANTICS_OUTPUT') host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_OUTPUT_INVALID', 'Independent inspection rejected the output.', 502, error); host('PDF_ACCESSIBILITY_TABLE_SEMANTICS_FAILED', 'The local host could not create a verified table semantics artifact.', 502, error); }
    finally { deadline.dispose(); await cleanupPdfAccessibilityTableSemanticsJob({ store: this.#store, lifecycle }); }
  }
  async update(documentId, value, options = {}) { return this.repair(documentId, value, options); }
}
export const AccessibilityTableSemanticsService = PdfAccessibilityTableSemanticsService;
export { PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE };
