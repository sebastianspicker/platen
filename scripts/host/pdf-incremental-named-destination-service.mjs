import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { normalizeIncrementalNamedDestination } from './pdf-incremental-named-destination-contract.mjs';
import { inspectIncrementalPdfNamedDestination, writeIncrementalPdfNamedDestination } from './pdf-incremental-named-destination-writer.mjs';
import { runIncrementalNamedDestinationJob } from './pdf-incremental-named-destination-job.mjs';
import { MAX_INCREMENTAL_NAMED_DESTINATION_SOURCE_BYTES } from './pdf-incremental-named-destination-validation.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const CORE_METHODS = Object.freeze(['normalizeIncrementalNamedDestination', 'writeIncrementalPdfNamedDestination', 'inspectIncrementalPdfNamedDestination']);
const CORE = Object.freeze({ normalizeIncrementalNamedDestination, writeIncrementalPdfNamedDestination, inspectIncrementalPdfNamedDestination });
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
async function cleanup(store, lifecycle) {
  const items = await Promise.allSettled(lifecycle.workspaces.reverse().map((path) => store.cleanupJob(path)));
  const workspaceFailed = items.some((item) => item.status === 'rejected');
  let artifactFailed = false;
  if ((!lifecycle.completed || workspaceFailed) && lifecycle.promotedArtifact?.artifact?.id) {
    try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { artifactFailed = true; }
  }
  if (workspaceFailed || artifactFailed) throw host('INCREMENTAL_NAMED_DESTINATION_CLEANUP_FAILED', 'Incremental named-destination processing could not clean its private workspace.', 500);
}

export class PdfIncrementalNamedDestinationService {
  #store; #poppler; #core;
  constructor({ store, poppler, core = CORE } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function') || !poppler || typeof poppler.execute !== 'function' || !core || CORE_METHODS.some((name) => typeof core[name] !== 'function')) throw new TypeError('PdfIncrementalNamedDestinationService requires fixed store, Poppler, and raw writer APIs.');
    this.#store = store; this.#poppler = poppler; this.#core = core;
  }
  async update(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request;
    try {
      request = this.#core.normalizeIncrementalNamedDestination(value);
      if (!NAME.test(request.name)) throw new Error('Invalid incremental named-destination name.');
    } catch (error) { throw host('INVALID_INCREMENTAL_NAMED_DESTINATION_OPTIONS', 'The requested incremental named destination is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The incremental named-destination source digest does not match the current document.', 409);
    if (source.size < 5 || source.size > MAX_INCREMENTAL_NAMED_DESTINATION_SOURCE_BYTES) throw host('INCREMENTAL_NAMED_DESTINATION_INPUT_TOO_LARGE', 'Incremental named destinations are limited to non-empty 128 MiB documents.', 413);
    const deadline = createDeadline(signal, 120_000);
    const lifecycle = { workspaces: [], sourceBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
    try { return await runIncrementalNamedDestinationJob({ store: this.#store, poppler: this.#poppler, core: this.#core, documentId, source, request, deadline, lifecycle }); } catch (error) {
      if (deadline.timedOut) throw host('INCREMENTAL_NAMED_DESTINATION_TIMEOUT', 'Incremental named-destination processing exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted) throw host('JOB_CANCELLED', 'Incremental named-destination processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_INCREMENTAL_NAMED_DESTINATION_PDF') throw host('INCREMENTAL_NAMED_DESTINATION_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded incremental named-destination subset.', 422, error);
      if (error?.code === 'INVALID_INCREMENTAL_NAMED_DESTINATION_OUTPUT') throw host('INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID', 'The append-only named-destination output failed separate raw reinspection.', 502, error);
      throw host('INCREMENTAL_NAMED_DESTINATION_FAILED', 'The local host could not create a verified append-only named-destination copy.', 502, error);
    } finally { deadline.dispose(); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); await cleanup(this.#store, lifecycle); }
  }
}
