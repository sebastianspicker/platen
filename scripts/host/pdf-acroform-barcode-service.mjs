import { HostError } from './host-error.mjs';
import { createDeadline } from './workspace-job-runtime.mjs';
import { normalizePdfAcroFormBarcodeRequest, PDF_ACROFORM_BARCODE_PROFILE } from './pdf-acroform-barcode-contract.mjs';
import { cleanupPdfAcroFormBarcodeJob, MAX_PDF_ACROFORM_BARCODE_JOB_MS, MAX_PDF_ACROFORM_BARCODE_SOURCE_BYTES, runPdfAcroFormBarcodeJob } from './pdf-acroform-barcode-job.mjs';

const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'getArtifact', 'deleteArtifact']);
function host(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
export class PdfAcroFormBarcodeService {
  #store;
  constructor({ store } = {}) { if (!store || METHODS.some((method) => typeof store[method] !== 'function')) throw new TypeError('PdfAcroFormBarcodeService requires a DocumentStore-compatible store.'); this.#store = store; }
  async add(documentId, value, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request; try { request = normalizePdfAcroFormBarcodeRequest(value); } catch (error) { host('PDF_ACROFORM_BARCODE_OPTIONS_INVALID', 'The PDF barcode-field request is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId); if (request.sourceSha256 !== source.sha256) host('SOURCE_VERSION_MISMATCH', 'The barcode-field source digest does not match the current document.', 409); if (!Number.isSafeInteger(source.size) || source.size < 64 || source.size > MAX_PDF_ACROFORM_BARCODE_SOURCE_BYTES) host('PDF_ACROFORM_BARCODE_INPUT_TOO_LARGE', 'The barcode-field source exceeds its fixed bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_ACROFORM_BARCODE_JOB_MS); const lifecycle = { workspace: null, promotedArtifact: null, completed: false };
    try { return await runPdfAcroFormBarcodeJob({ store: this.#store, documentId, source, request, deadline, lifecycle }); }
    catch (error) { if (deadline.timedOut) host('PDF_ACROFORM_BARCODE_TIMEOUT', 'PDF barcode-field creation exceeded its deadline.', 504, error); if (signal?.aborted || error?.code === 'JOB_CANCELLED') host('JOB_CANCELLED', 'PDF barcode-field creation was cancelled.', 499, error); if (error instanceof HostError) throw error; if (error?.code === 'UNSUPPORTED_PDF_ACROFORM_BARCODE_SOURCE') host('PDF_ACROFORM_BARCODE_SOURCE_UNSUPPORTED', 'The source is outside the bounded passive barcode-field subset.', 422, error); if (error?.code === 'INVALID_PDF_ACROFORM_BARCODE_OUTPUT') host('PDF_ACROFORM_BARCODE_OUTPUT_INVALID', 'Independent inspection rejected the barcode-field output.', 502, error); host('PDF_ACROFORM_BARCODE_FAILED', 'The local host could not create a verified barcode-field artifact.', 502, error); }
    finally { deadline.dispose(); await cleanupPdfAcroFormBarcodeJob({ store: this.#store, lifecycle }); }
  }
  async create(documentId, value, options = {}) { return this.add(documentId, value, options); }
}
export const AcroFormBarcodeService = PdfAcroFormBarcodeService;
export { PDF_ACROFORM_BARCODE_PROFILE };
