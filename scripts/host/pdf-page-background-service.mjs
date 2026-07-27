import { createDeadline } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { PDF_PAGE_BACKGROUND_PROFILE, normalizePdfPageBackground } from './pdf-page-background-contract.mjs';
import { inspectPdfPageBackground, writePdfPageBackground } from './pdf-page-background-writer.mjs';
import { runPdfPageBackgroundJob } from './pdf-page-background-job.mjs';

const MAX_JOB_MS = 120_000;
const CORE = Object.freeze({ writePdfPageBackground, inspectPdfPageBackground });
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function snapshotRequest(value) { try { return normalizePdfPageBackground(value); } catch (error) { throw host('PDF_PAGE_BACKGROUND_OPTIONS_INVALID', 'Page-background options must be an exact source-bound request.', 400, error); } }

async function cleanup(store, lifecycle) {
  const results = await Promise.allSettled(lifecycle.workspaces.reverse().map((workspace) => store.cleanupJob(workspace)));
  const failed = results.some(({ status }) => status === 'rejected'); let artifactFailed = false;
  if ((!lifecycle.completed || failed) && lifecycle.promotedArtifact?.artifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { artifactFailed = true; } }
  if (failed || artifactFailed) throw host('PDF_PAGE_BACKGROUND_CLEANUP_FAILED', 'Page-background processing could not clean its private workspace.', 500);
}

export const PDF_PAGE_BACKGROUND_LIMITATIONS = Object.freeze([
  'Only opaque solid RGB fills behind selected unrotated pages whose CropBox exactly equals MediaBox are supported.',
  'This local operation does not provide transparency, images, templates, bleed handling, or cross-viewer equivalence.',
  'The source revision remains the historical prefix; the result is an append-only incremental revision.',
]);

export class PdfPageBackgroundService {
  #store; #core;
  constructor({ store, core = CORE } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function') || !core || typeof core.writePdfPageBackground !== 'function' || typeof core.inspectPdfPageBackground !== 'function') throw new TypeError('PdfPageBackgroundService requires fixed store and page-background writer APIs.');
    this.#store = store; this.#core = core;
  }
  async create(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const request = snapshotRequest(value);
    try {
      const source = this.#store.getDocument(documentId);
      if (sourceSha256 !== source.sha256 || request.sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The page-background source digest does not match the current document.', 409);
      const deadline = createDeadline(signal, MAX_JOB_MS); const lifecycle = { workspaces: [], sourceBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
      try { return await runPdfPageBackgroundJob({ store: this.#store, documentId, source, request, deadline, lifecycle, core: this.#core }); }
      catch (error) {
        if (deadline.timedOut) throw host('PDF_PAGE_BACKGROUND_TIMEOUT', 'Page-background processing exceeded its two-minute deadline.', 504, error);
        if (signal?.aborted) throw host('JOB_CANCELLED', 'Page-background processing was cancelled.', 499, error);
        if (error instanceof HostError) throw error;
        if (error?.code === 'UNSUPPORTED_PDF_PAGE_BACKGROUND') throw host('PDF_PAGE_BACKGROUND_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded page-background subset.', 422, error);
        if (error?.code === 'INVALID_PDF_PAGE_BACKGROUND') throw host('PDF_PAGE_BACKGROUND_OPTIONS_INVALID', 'Page-background options are invalid for this operation.', 400, error);
        if (error?.code === 'INVALID_PDF_PAGE_BACKGROUND_OUTPUT') throw host('PDF_PAGE_BACKGROUND_OUTPUT_INVALID', 'The page-background output failed deterministic validation.', 502, error);
        throw host('PDF_PAGE_BACKGROUND_FAILED', 'The local host could not create a verified page-background artifact.', 502, error);
      } finally { deadline.dispose(); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); await cleanup(this.#store, lifecycle); }
    } catch (error) { throw error; }
  }
  async apply(documentId, value, options = {}) { return this.create(documentId, value, options); }
}
