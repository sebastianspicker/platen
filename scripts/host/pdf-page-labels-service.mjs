import { createDeadline } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { PDF_PAGE_LABELS_PROFILE, inspectPdfPageLabels, writePdfPageLabels } from './pdf-page-labels-writer.mjs';
import { runPdfPageLabelsJob } from './pdf-page-labels-job.mjs';

const SHA256 = /^[0-9a-f]{64}$/u; const MAX_JOB_MS = 120_000; const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const CORE = Object.freeze({ writePdfPageLabels, inspectPdfPageLabels });
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function snapshotRequest(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.ranges)) throw new Error();
    return Object.freeze({ ...value, ranges: Object.freeze(value.ranges.map((range) => Object.freeze({ ...range }))) });
  } catch { throw host('PDF_PAGE_LABELS_OPTIONS_INVALID', 'Page-label options must be an exact source-bound request.', 400); }
}
async function cleanup(store, lifecycle) {
  const results = await Promise.allSettled(lifecycle.workspaces.reverse().map((workspace) => store.cleanupJob(workspace))); const failed = results.some(({ status }) => status === 'rejected'); let artifactFailed = false;
  if ((!lifecycle.completed || failed) && lifecycle.promotedArtifact?.artifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { artifactFailed = true; } }
  if (failed || artifactFailed) throw host('PDF_PAGE_LABELS_CLEANUP_FAILED', 'Page-label processing could not clean its private workspace.', 500);
}
export const PDF_PAGE_LABELS_LIMITATIONS = Object.freeze(['Only flat direct page trees and direct page-label dictionaries are supported.', 'This local operation does not provide label-based navigation disambiguation or general number-tree editing.']);

export class PdfPageLabelsService {
  #store; #core;
  constructor({ store, core = CORE } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function') || !core || typeof core.writePdfPageLabels !== 'function' || typeof core.inspectPdfPageLabels !== 'function') throw new TypeError('PdfPageLabelsService requires fixed store and page-label writer APIs.');
    this.#store = store; this.#core = core;
  }
  async create(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.'); const request = snapshotRequest(value);
    try {
      const source = this.#store.getDocument(documentId); if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The page-label source digest does not match the current document.', 409);
      if (source.size < 32 || source.size > MAX_SOURCE_BYTES) throw host('PDF_PAGE_LABELS_INPUT_TOO_LARGE', 'Page-label authoring is limited to bounded PDF sources.', 413);
      const deadline = createDeadline(signal, MAX_JOB_MS); const lifecycle = { workspaces: [], sourceBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
      try { return await runPdfPageLabelsJob({ store: this.#store, documentId, source, request, deadline, lifecycle, core: this.#core }); }
      catch (error) {
        if (deadline.timedOut) throw host('PDF_PAGE_LABELS_TIMEOUT', 'Page-label processing exceeded its two-minute deadline.', 504, error);
        if (signal?.aborted) throw host('JOB_CANCELLED', 'Page-label processing was cancelled.', 499, error);
        if (error instanceof HostError) throw error;
        if (error?.code === 'UNSUPPORTED_PDF_PAGE_LABELS_PDF') throw host('PDF_PAGE_LABELS_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded page-label subset.', 422, error);
        if (error?.code === 'INVALID_PDF_PAGE_LABELS') throw host('PDF_PAGE_LABELS_OPTIONS_INVALID', 'Page-label options are invalid for this operation.', 400, error);
        if (error?.code === 'INVALID_PDF_PAGE_LABELS_OUTPUT') throw host('PDF_PAGE_LABELS_OUTPUT_INVALID', 'The page-label output failed deterministic validation.', 502, error);
        throw host('PDF_PAGE_LABELS_FAILED', 'The local host could not create a verified page-label artifact.', 502, error);
      } finally { deadline.dispose(); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); await cleanup(this.#store, lifecycle); }
    } finally { request.ranges.forEach((range) => { if (Buffer.isBuffer(range.prefix)) range.prefix.fill(0); }); }
  }
  async update(documentId, value, options = {}) { return this.create(documentId, value, options); }
}
