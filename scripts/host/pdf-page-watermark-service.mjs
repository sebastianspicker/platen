import { createDeadline } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { cleanupPdfPageWatermarkJob, MAX_PDF_PAGE_WATERMARK_JOB_MS, MAX_PDF_PAGE_WATERMARK_SOURCE_BYTES, PDF_PAGE_WATERMARK_LIMITATIONS, runPdfPageWatermarkJob } from './pdf-page-watermark-job.mjs';
import { normalizePdfPageWatermark, PDF_PAGE_WATERMARK_PROFILE } from './pdf-page-watermark-contract.mjs';
import { inspectPdfPageWatermark, writePdfPageWatermark } from './pdf-page-watermark-writer.mjs';

const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const CORE = Object.freeze({ writePdfPageWatermark, inspectPdfPageWatermark });
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function snapshotRequest(value) { try { return normalizePdfPageWatermark(value); } catch (error) { throw host('PDF_PAGE_WATERMARK_OPTIONS_INVALID', 'Page-watermark options must be an exact source-bound request.', 400, error); } }
function publicArtifact(value) {
  const allowed = ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'createdAt'];
  return Object.freeze(Object.fromEntries(allowed.filter((key) => Object.hasOwn(value ?? {}, key)).map((key) => [key, value[key]])));
}

export class PdfPageWatermarkService {
  #store; #core;
  constructor({ store, core = CORE } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function') || !core || typeof core.writePdfPageWatermark !== 'function' || typeof core.inspectPdfPageWatermark !== 'function') throw new TypeError('PdfPageWatermarkService requires fixed store and page-watermark writer APIs.');
    this.#store = store; this.#core = core;
  }
  async create(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const request = snapshotRequest(value); const source = this.#store.getDocument(documentId);
    if (sourceSha256 !== source.sha256 || request.sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The page-watermark source digest does not match the current document.', 409);
    if (source.size > MAX_PDF_PAGE_WATERMARK_SOURCE_BYTES) throw host('PDF_PAGE_WATERMARK_INPUT_TOO_LARGE', 'The page-watermark source exceeds its bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_PAGE_WATERMARK_JOB_MS); const lifecycle = { workspaces: [], sourceBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
    try {
      const internal = await runPdfPageWatermarkJob({ store: this.#store, documentId, source, request, deadline, lifecycle, core: this.#core });
      return Object.freeze({ kind: 'pdf-page-watermark', artifact: publicArtifact(internal.artifact), pages: Object.freeze(internal.proof.pages.map(({ page, applied }) => Object.freeze({ page, applied }))), evidence: Object.freeze({ sourceDigestReverified: true, sourcePrefixPreserved: true, watermarkTextEffectProven: true, onlySelectedPagesChanged: true, pageBoxesPreserved: true, resourcesPreserved: true, annotationsPreserved: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true }), limitations: PDF_PAGE_WATERMARK_LIMITATIONS });
    } catch (error) {
      if (deadline.timedOut) throw host('PDF_PAGE_WATERMARK_TIMEOUT', 'Page-watermark processing exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted || error?.code === 'JOB_CANCELLED') throw host('JOB_CANCELLED', 'Page-watermark processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_PDF_PAGE_WATERMARK') throw host('PDF_PAGE_WATERMARK_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded passive watermark subset.', 422, error);
      if (error?.code === 'INVALID_PDF_PAGE_WATERMARK' || error?.code === 'INVALID_PDF_PAGE_WATERMARK_OUTPUT') throw host('PDF_PAGE_WATERMARK_OUTPUT_INVALID', 'The page-watermark output failed deterministic validation.', 502, error);
      throw host('PDF_PAGE_WATERMARK_FAILED', 'The local host could not create a verified page-watermark artifact.', 502, error);
    } finally { deadline.dispose(); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); await cleanupPdfPageWatermarkJob({ store: this.#store, lifecycle }); }
  }
  async apply(documentId, value, options = {}) { return this.create(documentId, value, options); }
}

export const PageWatermarkService = PdfPageWatermarkService;
export { PDF_PAGE_WATERMARK_LIMITATIONS, PDF_PAGE_WATERMARK_PROFILE };
