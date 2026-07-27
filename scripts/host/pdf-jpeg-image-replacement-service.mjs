import { createDeadline } from './pdf-service-foundation.mjs';
import { HostError } from './host-error.mjs';
import { inspectPdfJpegImageReplacement, writePdfJpegImageReplacement, PDF_JPEG_IMAGE_REPLACEMENT_PROFILE } from './pdf-jpeg-image-replacement-writer.mjs';
import { runPdfJpegImageReplacementJob } from './pdf-jpeg-image-replacement-job.mjs';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024; const MAX_JOB_MS = 120_000; const SHA256 = /^[0-9a-f]{64}$/u;
function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function snapshotRequest(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw host('PDF_JPEG_IMAGE_REPLACEMENT_OPTIONS_INVALID', 'JPEG replacement options are invalid.', 400); const descriptors = Object.getOwnPropertyDescriptors(value); const keys = ['profile', 'sourceSha256', 'page', 'resourceName', 'jpegBytes']; if (Object.keys(descriptors).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) throw host('PDF_JPEG_IMAGE_REPLACEMENT_OPTIONS_INVALID', 'JPEG replacement options are invalid.', 400);
if (!Buffer.isBuffer(descriptors.jpegBytes.value)) throw host('PDF_JPEG_IMAGE_REPLACEMENT_OPTIONS_INVALID', 'JPEG replacement options are invalid.', 400); return Object.freeze({ profile: descriptors.profile.value, sourceSha256: descriptors.sourceSha256.value, page: descriptors.page.value, resourceName: descriptors.resourceName.value, jpegBytes: Buffer.from(descriptors.jpegBytes.value) }); }
function cleanup(store, lifecycle) { return Promise.allSettled(lifecycle.workspaces.reverse().map((workspace) => store.cleanupJob(workspace))).then(async (results) => { const workspaceFailed = results.some(({ status }) => status === 'rejected'); let artifactFailed = false; if ((workspaceFailed || !lifecycle.completed) && lifecycle.promotedArtifact?.artifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { artifactFailed = true; } } if (workspaceFailed || artifactFailed) throw host('PDF_JPEG_IMAGE_REPLACEMENT_CLEANUP_FAILED', 'Replacement processing could not clean its private workspace or revoke its artifact.', 500); }); }
export class PdfJpegImageReplacementService {
  #store; #core; #poppler;
  constructor({ store, core = { writePdfJpegImageReplacement, inspectPdfJpegImageReplacement }, poppler = null } = {}) { if (!store || !['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact'].every((name) => typeof store[name] === 'function')) throw new TypeError('PdfJpegImageReplacementService requires a document store.'); this.#store = store; this.#core = core; this.#poppler = poppler; }
  async replace(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const request = snapshotRequest(value);
    try {
      const source = this.#store.getDocument(documentId); if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The JPEG replacement source digest does not match the current document.', 409); if (source.size < 32 || source.size > MAX_SOURCE_BYTES) throw host('PDF_JPEG_IMAGE_REPLACEMENT_INPUT_TOO_LARGE', 'JPEG replacement is limited to bounded PDF sources.', 413);
      const deadline = createDeadline(signal, MAX_JOB_MS); const lifecycle = { workspaces: [], sourceBytes: null, outputBytes: null, promotedArtifact: null, completed: false };
      try { return await runPdfJpegImageReplacementJob({ store: this.#store, documentId, source, request, deadline, lifecycle, core: this.#core, poppler: this.#poppler }); }
      catch (error) { if (deadline.timedOut) throw host('PDF_JPEG_IMAGE_REPLACEMENT_TIMEOUT', 'JPEG replacement exceeded its deadline.', 504, error); if (signal?.aborted) throw host('JOB_CANCELLED', 'JPEG replacement was cancelled.', 499, error); if (error instanceof HostError) throw error; if (error?.code === 'UNSUPPORTED_PDF_JPEG_IMAGE_REPLACEMENT') throw host('PDF_JPEG_IMAGE_REPLACEMENT_SOURCE_UNSUPPORTED', 'The PDF is outside the supported replacement subset.', 422, error); if (error?.code === 'INVALID_PDF_JPEG_IMAGE_REPLACEMENT') throw host('PDF_JPEG_IMAGE_REPLACEMENT_OPTIONS_INVALID', 'JPEG replacement options or bytes are invalid.', 400, error); if (error?.code === 'INVALID_PDF_JPEG_IMAGE_REPLACEMENT_OUTPUT') throw host('PDF_JPEG_IMAGE_REPLACEMENT_OUTPUT_INVALID', 'Replacement output failed deterministic validation.', 502, error);
throw host('PDF_JPEG_IMAGE_REPLACEMENT_FAILED', 'The local host could not create a verified replacement artifact.', 502, error); }
      finally { deadline.dispose(); await cleanup(this.#store, lifecycle); }
    } finally { request.jpegBytes.fill(0); }
  }
}
export { PDF_JPEG_IMAGE_REPLACEMENT_PROFILE };
