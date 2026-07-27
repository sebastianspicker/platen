import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { normalizeAnnotationFlatten } from './pdf-annotation-flatten-contract.mjs';
import { inspectIncrementalAnnotationFlatten, writeIncrementalAnnotationFlatten } from './pdf-incremental-annotation-flatten-writer.mjs';
import { runPdfAnnotationFlattenJob } from './pdf-annotation-flatten-job.mjs';
import { MAX_PDF_ANNOTATION_FLATTEN_SOURCE_BYTES } from './pdf-annotation-flatten-validation.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JOB_MS = 120_000;
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const CORE_METHODS = Object.freeze(['normalizePdfAnnotationFlatten', 'writePdfAnnotationFlatten', 'inspectPdfAnnotationFlatten']);
const CORE = Object.freeze({ normalizePdfAnnotationFlatten: normalizeAnnotationFlatten, writePdfAnnotationFlatten: writeIncrementalAnnotationFlatten, inspectPdfAnnotationFlatten: inspectIncrementalAnnotationFlatten });
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }

async function cleanup(store, lifecycle) {
  const outcomes = await Promise.allSettled(lifecycle.workspaces.reverse().map((path) => store.cleanupJob(path)));
  const workspaceFailed = outcomes.some((outcome) => outcome.status === 'rejected');
  let artifactFailed = false;
  if ((!lifecycle.completed || workspaceFailed) && lifecycle.promotedArtifact?.artifact?.id) {
    try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { artifactFailed = true; }
  }
  if (workspaceFailed || artifactFailed) throw host('PDF_ANNOTATION_FLATTEN_CLEANUP_FAILED', 'Annotation flatten processing could not clean its private workspace.', 500);
}

export class PdfAnnotationFlattenService {
  #store; #poppler; #core;
  constructor({ store, poppler, core = CORE } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function') || !poppler || typeof poppler.execute !== 'function' || !core || CORE_METHODS.some((name) => typeof core[name] !== 'function')) throw new TypeError('PdfAnnotationFlattenService requires fixed store, Poppler, and raw writer APIs.');
    this.#store = store; this.#poppler = poppler; this.#core = core;
  }
  async flatten(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request;
    try { request = this.#core.normalizePdfAnnotationFlatten(value); } catch (error) { throw host('INVALID_PDF_ANNOTATION_FLATTEN_OPTIONS', 'The annotation-flatten request is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256 || request.sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The annotation-flatten source digest does not match the current document.', 409);
    if (source.size < 5 || source.size > MAX_PDF_ANNOTATION_FLATTEN_SOURCE_BYTES) throw host('PDF_ANNOTATION_FLATTEN_INPUT_TOO_LARGE', 'Annotation flatten is limited to non-empty 64 MiB documents.', 413);
    const deadline = createDeadline(signal, MAX_JOB_MS);
    const lifecycle = { workspaces: [], sourceBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
    try { return await runPdfAnnotationFlattenJob({ store: this.#store, poppler: this.#poppler, core: this.#core, documentId, source, request, deadline, lifecycle }); } catch (error) {
      if (deadline.timedOut) throw host('PDF_ANNOTATION_FLATTEN_TIMEOUT', 'Annotation flatten processing exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted) throw host('JOB_CANCELLED', 'Annotation flatten processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'INVALID_ANNOTATION_FLATTEN' || error?.code === 'UNSUPPORTED_ANNOTATION_FLATTEN_PDF') throw host('PDF_ANNOTATION_FLATTEN_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded square-annotation flatten subset.', 422, error);
      if (error?.code === 'INVALID_ANNOTATION_FLATTEN_OUTPUT') throw host('PDF_ANNOTATION_FLATTEN_OUTPUT_INVALID', 'The compact annotation-flatten output failed separate raw reinspection.', 502, error);
      throw host('PDF_ANNOTATION_FLATTEN_FAILED', 'The local host could not create a verified flattened square-annotation PDF copy.', 502, error);
    } finally { deadline.dispose(); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); await cleanup(this.#store, lifecycle); }
  }
}
