import { createDeadline } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { normalizePdfPageHeaderFooter, PDF_PAGE_HEADER_FOOTER_PROFILE } from './pdf-page-header-footer-contract.mjs';
import { cleanupPdfPageHeaderFooterJob, MAX_PDF_PAGE_HEADER_FOOTER_JOB_MS, MAX_PDF_PAGE_HEADER_FOOTER_SOURCE_BYTES, runPdfPageHeaderFooterJob } from './pdf-page-header-footer-job.mjs';
import { inspectPdfPageHeaderFooter, writePdfPageHeaderFooter } from './pdf-page-header-footer-writer.mjs';
import { PDF_PAGE_HEADER_FOOTER_LIMITATIONS } from '../../src/core/pdf-page-header-footer-contract.js';

const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const CORE = Object.freeze({ writePdfPageHeaderFooter, inspectPdfPageHeaderFooter });
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function request(value) { try { return normalizePdfPageHeaderFooter(value); } catch (error) { throw host('PDF_PAGE_HEADER_FOOTER_OPTIONS_INVALID', 'Page header/footer options must be an exact source-bound request.', 400, error); } }
function publicArtifact(value) { return Object.freeze(Object.fromEntries(['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'createdAt'].map((key) => [key, value[key]]))); }
export class PdfPageHeaderFooterService {
  #store; #core;
  constructor({ store, core = CORE } = {}) { if (!store || METHODS.some((key) => typeof store[key] !== 'function') || !core || typeof core.writePdfPageHeaderFooter !== 'function' || typeof core.inspectPdfPageHeaderFooter !== 'function') throw new TypeError('PdfPageHeaderFooterService requires fixed store and header/footer writer APIs.'); this.#store = store; this.#core = core; }
  async create(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.'); const frozen = request(value); const source = this.#store.getDocument(documentId);
    if (sourceSha256 !== source.sha256 || frozen.sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The page header/footer source digest does not match the current document.', 409);
    if (source.size > MAX_PDF_PAGE_HEADER_FOOTER_SOURCE_BYTES) throw host('PDF_PAGE_HEADER_FOOTER_INPUT_TOO_LARGE', 'The page header/footer source exceeds its bound.', 413);
    const deadline = createDeadline(signal, MAX_PDF_PAGE_HEADER_FOOTER_JOB_MS); const lifecycle = { workspaces: [], sourceBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
    try { const internal = await runPdfPageHeaderFooterJob({ store: this.#store, documentId, source, request: frozen, deadline, lifecycle, core: this.#core }); return Object.freeze({ kind: 'pdf-page-header-footer', artifact: publicArtifact(internal.artifact), pages: Object.freeze(internal.proof.pages.map(({ page, applied }) => Object.freeze({ page, applied }))), evidence: Object.freeze({ sourceDigestReverified: true, sourcePrefixPreserved: true, headerFooterEffectProven: true, onlySelectedPagesChanged: true, pageBoxesPreserved: true, resourcesPreserved: true, annotationsPreserved: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true }), limitations: PDF_PAGE_HEADER_FOOTER_LIMITATIONS });
    } catch (error) {
      if (deadline.timedOut) throw host('PDF_PAGE_HEADER_FOOTER_TIMEOUT', 'Page header/footer processing exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted || error?.code === 'JOB_CANCELLED') throw host('JOB_CANCELLED', 'Page header/footer processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_PDF_PAGE_HEADER_FOOTER') throw host('PDF_PAGE_HEADER_FOOTER_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded passive header/footer subset.', 422, error);
      if (error?.code === 'INVALID_PDF_PAGE_HEADER_FOOTER' || error?.code === 'INVALID_PDF_PAGE_HEADER_FOOTER_OUTPUT') throw host('PDF_PAGE_HEADER_FOOTER_OUTPUT_INVALID', 'The page header/footer output failed deterministic validation.', 502, error);
      throw host('PDF_PAGE_HEADER_FOOTER_FAILED', 'The local host could not create a verified page header/footer artifact.', 502, error);
    } finally {
      deadline.dispose();
      lifecycle.sourceBytes?.fill(0);
      lifecycle.outputBytes?.fill(0);
      await cleanupPdfPageHeaderFooterJob({ store: this.#store, lifecycle });
    }
  }
  async apply(documentId, value, options = {}) { return this.create(documentId, value, options); }
}
export const PageHeaderFooterService = PdfPageHeaderFooterService;
export { PDF_PAGE_HEADER_FOOTER_LIMITATIONS, PDF_PAGE_HEADER_FOOTER_PROFILE };
