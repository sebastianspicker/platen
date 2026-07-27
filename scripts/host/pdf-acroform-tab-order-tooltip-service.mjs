import { createDeadline } from './workspace-job-runtime.mjs';
import { HostError } from './host-error.mjs';
import { cleanupAcroFormTabOrderTooltipJob, MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_JOB_MS, MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_SOURCE_BYTES, runAcroFormTabOrderTooltipJob } from './pdf-acroform-tab-order-tooltip-job.mjs';
import { normalizePdfAcroFormTabOrderTooltip, PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE } from './pdf-acroform-tab-order-tooltip-contract.mjs';

const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }

export class PdfAcroFormTabOrderTooltipService {
  #store;
  constructor({ store } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function')) throw new TypeError('PdfAcroFormTabOrderTooltipService requires a DocumentStore-compatible store.'); this.#store = store; }
  async update(documentId, request, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let normalized; try { normalized = normalizePdfAcroFormTabOrderTooltip(request); } catch (error) { host('INVALID_ACROFORM_TAB_ORDER_TOOLTIP_OPTIONS', 'The tab-order and tooltip request is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId); if (normalized.sourceSha256 !== source.sha256) host('SOURCE_VERSION_MISMATCH', 'The tab-order and tooltip source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 32 || source.size > MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_SOURCE_BYTES) host('ACROFORM_TAB_ORDER_TOOLTIP_INPUT_TOO_LARGE', 'The tab-order and tooltip source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_JOB_MS); const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
    try { return await runAcroFormTabOrderTooltipJob({ store: this.#store, documentId, source, request: normalized, deadline, lifecycle }); }
    catch (error) {
      if (deadline.timedOut) host('ACROFORM_TAB_ORDER_TOOLTIP_TIMEOUT', 'Tab-order and tooltip processing exceeded its deadline.', 504, error);
      if (signal?.aborted || error?.code === 'JOB_CANCELLED') host('JOB_CANCELLED', 'Tab-order and tooltip processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_PDF_ACROFORM_TAB_ORDER_TOOLTIP_SOURCE') host('ACROFORM_TAB_ORDER_TOOLTIP_SOURCE_UNSUPPORTED', 'The source is outside the bounded passive tab-order and tooltip subset.', 422, error);
      if (error?.code === 'INVALID_PDF_ACROFORM_TAB_ORDER_TOOLTIP_OUTPUT') host('ACROFORM_TAB_ORDER_TOOLTIP_OUTPUT_INVALID', 'Independent inspection rejected the output.', 502, error);
      if (error?.code === 'INVALID_PDF_ACROFORM_TAB_ORDER_TOOLTIP') host('INVALID_ACROFORM_TAB_ORDER_TOOLTIP_OPTIONS', 'The tab-order and tooltip request is invalid.', 400, error);
      host('ACROFORM_TAB_ORDER_TOOLTIP_FAILED', 'The local host could not create a verified tab-order and tooltip artifact.', 502, error);
    } finally { deadline.dispose(); await cleanupAcroFormTabOrderTooltipJob({ store: this.#store, lifecycle }); }
  }
  async add(documentId, request, options = {}) { return this.update(documentId, request, options); }
}

export const AcroFormTabOrderTooltipService = PdfAcroFormTabOrderTooltipService;
export const PdfAcroFormTabOrderTooltipsService = PdfAcroFormTabOrderTooltipService;
export const AcroFormTabOrderTooltipsService = PdfAcroFormTabOrderTooltipService;
export { PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE };
