import { createDeadline } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { PDF_JPEG_IMAGE_PROFILE, writePdfJpegImage, inspectPdfJpegImage } from './pdf-jpeg-image-writer.mjs';
import { runPdfJpegImageJob } from './pdf-jpeg-image-job.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_JOB_MS = 120_000;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);
const CORE = Object.freeze({ writePdfJpegImage, inspectPdfJpegImage });

function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function snapshotRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.rect || !Buffer.isBuffer(value.jpegBytes)) throw host('PDF_JPEG_IMAGE_OPTIONS_INVALID', 'JPEG image options must be an exact source-bound request.', 400);
  return Object.freeze({ ...value, rect: Object.freeze({ ...value.rect }), jpegBytes: Buffer.from(value.jpegBytes) });
}
async function cleanup(store, lifecycle) {
  const results = await Promise.allSettled(lifecycle.workspaces.reverse().map((workspace) => store.cleanupJob(workspace)));
  const failed = results.some(({ status }) => status === 'rejected'); let artifactFailed = false;
  if ((!lifecycle.completed || failed) && lifecycle.promotedArtifact?.artifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { artifactFailed = true; } }
  if (failed || artifactFailed) throw host('PDF_JPEG_IMAGE_CLEANUP_FAILED', 'JPEG image processing could not clean its private workspace.', 500);
}

export const PDF_JPEG_IMAGE_LIMITATIONS = Object.freeze(['Only one baseline grayscale or RGB JPEG is inserted into one direct CropBox-contained placement.', 'Only flat direct page trees and direct resource dictionaries are supported; historical source bytes remain in the append-only revision.', 'This local operation does not establish general image authoring, color fidelity, or print-production equivalence.']);

export class PdfJpegImageService {
  #store; #core;
  constructor({ store, core = CORE } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function') || !core || typeof core.writePdfJpegImage !== 'function' || typeof core.inspectPdfJpegImage !== 'function') throw new TypeError('PdfJpegImageService requires fixed store and JPEG image writer APIs.');
    this.#store = store; this.#core = core;
  }
  async insert(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const request = snapshotRequest(value);
    try {
      const source = this.#store.getDocument(documentId);
      if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The JPEG image source digest does not match the current document.', 409);
      if (source.size < 32 || source.size > MAX_SOURCE_BYTES) throw host('PDF_JPEG_IMAGE_INPUT_TOO_LARGE', 'JPEG image insertion is limited to bounded PDF sources.', 413);
      const deadline = createDeadline(signal, MAX_JOB_MS); const lifecycle = { workspaces: [], sourceBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
      try { return await runPdfJpegImageJob({ store: this.#store, documentId, source, request, deadline, lifecycle, core: this.#core }); }
      catch (error) {
        if (deadline.timedOut) throw host('PDF_JPEG_IMAGE_TIMEOUT', 'JPEG image processing exceeded its two-minute deadline.', 504, error);
        if (signal?.aborted) throw host('JOB_CANCELLED', 'JPEG image processing was cancelled.', 499, error);
        if (error instanceof HostError) throw error;
        if (error?.code === 'UNSUPPORTED_PDF_JPEG_IMAGE_SOURCE') throw host('PDF_JPEG_IMAGE_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded JPEG image subset.', 422, error);
        if (error?.code === 'INVALID_PDF_JPEG_IMAGE') throw host('PDF_JPEG_IMAGE_OPTIONS_INVALID', 'JPEG image options or the supplied JPEG bytes are invalid.', 400, error);
        if (error?.code === 'INVALID_PDF_JPEG_IMAGE_OUTPUT') throw host('PDF_JPEG_IMAGE_OUTPUT_INVALID', 'The JPEG image operation failed deterministic validation.', 502, error);
        throw host('PDF_JPEG_IMAGE_FAILED', 'The local host could not create a verified JPEG image artifact.', 502, error);
      } finally { deadline.dispose(); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); await cleanup(this.#store, lifecycle); }
    } finally { request.jpegBytes.fill(0); }
  }
}
