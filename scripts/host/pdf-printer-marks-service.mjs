import { createDeadline } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { PDF_PRINTER_MARKS_PROFILE, inspectPdfPrinterMarks, writePdfPrinterMarks } from './pdf-printer-marks-writer.mjs';
import { runPdfPrinterMarksJob } from './pdf-printer-marks-job.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_JOB_MS = 120_000;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const CORE = Object.freeze({ writePdfPrinterMarks, inspectPdfPrinterMarks });
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function snapshotRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw host('PDF_PRINTER_MARKS_OPTIONS_INVALID', 'Printer-marks options must be an exact source-bound request.', 400);
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some((key) => !['profile', 'sourceSha256', 'pages'].includes(key)) || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) throw host('PDF_PRINTER_MARKS_OPTIONS_INVALID', 'Printer-marks options must be an exact source-bound request.', 400);
  const pages = descriptors.pages.value; if (!Array.isArray(pages) || Object.getPrototypeOf(pages) !== Array.prototype || Object.getOwnPropertySymbols(pages).length !== 0) throw host('PDF_PRINTER_MARKS_OPTIONS_INVALID', 'Printer-marks pages must be a plain array.', 400);
  const pageDescriptors = Object.getOwnPropertyDescriptors(pages); if (!Object.hasOwn(pageDescriptors, 'length') || Object.keys(pageDescriptors).length !== pages.length + 1 || !Object.hasOwn(pageDescriptors.length, 'value') || !Object.keys(pageDescriptors).filter((key) => key !== 'length').every((key) => /^\d+$/u.test(key) && Object.hasOwn(pageDescriptors[key], 'value') && pageDescriptors[key].enumerable === true)) throw host('PDF_PRINTER_MARKS_OPTIONS_INVALID', 'Printer-marks pages must be a plain array.', 400);
  return Object.freeze({ profile: descriptors.profile.value, sourceSha256: descriptors.sourceSha256.value, pages: Object.freeze(Array.from(pages)) });
}
async function cleanup(store, lifecycle) {
  const results = await Promise.allSettled(lifecycle.workspaces.reverse().map((workspace) => store.cleanupJob(workspace))); const failed = results.some(({ status }) => status === 'rejected'); let artifactFailed = false;
  if ((!lifecycle.completed || failed) && lifecycle.promotedArtifact?.artifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { artifactFailed = true; } }
  if (failed || artifactFailed) throw host('PDF_PRINTER_MARKS_CLEANUP_FAILED', 'Printer-marks processing could not clean its private workspace.', 500);
}
export const PDF_PRINTER_MARKS_LIMITATIONS = Object.freeze(['Marks are deterministic passive black vector lines outside TrimBox and inside BleedBox.', 'This local operation does not provide trapping, registration/color bars, imposition, PDF/X conformance, or printer equivalence.']);

export class PdfPrinterMarksService {
  #store; #core;
  constructor({ store, core = CORE } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function') || !core || typeof core.writePdfPrinterMarks !== 'function' || typeof core.inspectPdfPrinterMarks !== 'function') throw new TypeError('PdfPrinterMarksService requires fixed store and printer-marks writer APIs.');
    this.#store = store; this.#core = core;
  }
  async create(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.'); const request = snapshotRequest(value);
    try {
      const source = this.#store.getDocument(documentId); if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The printer-marks source digest does not match the current document.', 409);
      if (source.size < 32 || source.size > MAX_SOURCE_BYTES) throw host('PDF_PRINTER_MARKS_INPUT_TOO_LARGE', 'Printer-marks authoring is limited to bounded PDF sources.', 413);
      const deadline = createDeadline(signal, MAX_JOB_MS); const lifecycle = { workspaces: [], sourceBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
      try { return await runPdfPrinterMarksJob({ store: this.#store, documentId, source, request, deadline, lifecycle, core: this.#core }); }
      catch (error) {
        if (deadline.timedOut) throw host('PDF_PRINTER_MARKS_TIMEOUT', 'Printer-marks processing exceeded its two-minute deadline.', 504, error);
        if (signal?.aborted) throw host('JOB_CANCELLED', 'Printer-marks processing was cancelled.', 499, error);
        if (error instanceof HostError) throw error;
        if (error?.code === 'UNSUPPORTED_PDF_PRINTER_MARKS') throw host('PDF_PRINTER_MARKS_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded printer-marks subset.', 422, error);
        if (error?.code === 'INVALID_PDF_PRINTER_MARKS') throw host('PDF_PRINTER_MARKS_OPTIONS_INVALID', 'Printer-marks options are invalid for this operation.', 400, error);
        if (error?.code === 'INVALID_PDF_PRINTER_MARKS_OUTPUT') throw host('PDF_PRINTER_MARKS_OUTPUT_INVALID', 'The printer-marks output failed deterministic validation.', 502, error);
        throw host('PDF_PRINTER_MARKS_FAILED', 'The local host could not create a verified printer-marks artifact.', 502, error);
      } finally { deadline.dispose(); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); await cleanup(this.#store, lifecycle); }
    } finally { /* request contains only scalar page numbers */ }
  }
  async apply(documentId, value, options = {}) { return this.create(documentId, value, options); }
}
