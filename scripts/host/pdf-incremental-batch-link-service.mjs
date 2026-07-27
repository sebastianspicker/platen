import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { normalizeIncrementalBatchGoToLinks } from './pdf-incremental-batch-link-contract.mjs';
import { inspectIncrementalPdfBatchGoToLinks, writeIncrementalPdfBatchGoToLinks } from './pdf-incremental-goto-link-writer.mjs';
import { runIncrementalBatchLinkJob } from './pdf-incremental-batch-link-job.mjs';
import { MAX_INCREMENTAL_BATCH_LINK_SOURCE_BYTES } from './pdf-incremental-batch-link-validation.mjs';
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JOB_MS = 120_000;
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const CORE = Object.freeze({ normalizeIncrementalBatchGoToLinks, writeIncrementalPdfBatchGoToLinks, inspectIncrementalPdfBatchGoToLinks });
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
async function cleanup(store, lifecycle) {
  const items = await Promise.allSettled(lifecycle.workspaces.reverse().map((path) => store.cleanupJob(path)));
  const workspaceFailed = items.some((item) => item.status === 'rejected'); let artifactFailed = false;
  if ((!lifecycle.completed || workspaceFailed) && lifecycle.promotedArtifact?.artifact?.id) {
    try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { artifactFailed = true; }
  }
  if (workspaceFailed || artifactFailed) throw host('INCREMENTAL_BATCH_LINK_CLEANUP_FAILED', 'Incremental batch-link processing could not clean its private workspace.', 500);
}
export class PdfIncrementalBatchLinkService {
  #store; #poppler; #core;
  constructor({ store, poppler, core = CORE } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function') || !poppler || typeof poppler.execute !== 'function' || !core || !['normalizeIncrementalBatchGoToLinks', 'writeIncrementalPdfBatchGoToLinks', 'inspectIncrementalPdfBatchGoToLinks'].every((name) => typeof core[name] === 'function')) throw new TypeError('PdfIncrementalBatchLinkService requires fixed store, Poppler, and raw writer APIs.');
    this.#store = store; this.#poppler = poppler; this.#core = core;
  }
  async update(documentId, value, { sourceSha256, signal } = {}) {
    let request; try { request = this.#core.normalizeIncrementalBatchGoToLinks(value); } catch (error) { throw host('INVALID_INCREMENTAL_BATCH_LINK_OPTIONS', 'The requested batch-link records are invalid.', 400, error); }
    const source = this.#store.getDocument(documentId); if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The batch-link source digest does not match the current document.', 409);
    if (source.size < 5 || source.size > MAX_INCREMENTAL_BATCH_LINK_SOURCE_BYTES) throw host('INCREMENTAL_BATCH_LINK_INPUT_TOO_LARGE', 'Batch links are limited to non-empty 128 MiB documents.', 413);
    const deadline = createDeadline(signal, MAX_JOB_MS); const lifecycle = { workspaces: [], sourceBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
    try { return await runIncrementalBatchLinkJob({ store: this.#store, poppler: this.#poppler, core: this.#core, documentId, source, request, deadline, lifecycle }); } catch (error) {
      if (deadline.timedOut) throw host('INCREMENTAL_BATCH_LINK_TIMEOUT', 'Incremental batch-link processing exceeded its two-minute deadline.', 504, error); if (signal?.aborted) throw host('JOB_CANCELLED', 'Incremental batch-link processing was cancelled.', 499, error); if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_INCREMENTAL_GOTO_LINK_PDF') throw host('INCREMENTAL_BATCH_LINK_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded batch-link subset.', 422, error); if (error?.code === 'INVALID_INCREMENTAL_GOTO_LINK_OUTPUT') throw host('INCREMENTAL_BATCH_LINK_OUTPUT_INVALID', 'The append-only batch-link output failed separate raw reinspection.', 502, error); throw host('INCREMENTAL_BATCH_LINK_FAILED', 'The local host could not create a verified append-only batch-link copy.', 502, error);
    } finally { deadline.dispose(); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); await cleanup(this.#store, lifecycle); }
  }
}
