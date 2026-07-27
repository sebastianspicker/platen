import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { normalizePdfAttachmentRemoval } from './pdf-attachment-removal-contract.mjs';
import {
  inspectPdfAttachmentRemoval,
  writePdfAttachmentRemoval,
} from './pdf-attachment-removal-writer.mjs';
import { runPdfAttachmentRemovalJob } from './pdf-attachment-removal-job.mjs';
import {
  MAX_PDF_ATTACHMENT_REMOVAL_SOURCE_BYTES,
} from './pdf-attachment-removal-validation.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const STORE_METHODS = Object.freeze([
  'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace',
  'cleanupJob', 'promotePdfArtifact', 'deleteArtifact',
]);
const CORE_METHODS = Object.freeze([
  'normalizePdfAttachmentRemoval', 'writePdfAttachmentRemoval',
  'inspectPdfAttachmentRemoval',
]);
const CORE = Object.freeze({
  normalizePdfAttachmentRemoval,
  writePdfAttachmentRemoval,
  inspectPdfAttachmentRemoval,
});

function host(code, message, status = 502, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

async function cleanup(store, lifecycle) {
  const outcomes = await Promise.allSettled(
    lifecycle.workspaces.reverse().map((path) => store.cleanupJob(path)),
  );
  const workspaceFailed = outcomes.some(({ status }) => status === 'rejected');
  let artifactFailed = false;
  if ((!lifecycle.completed || workspaceFailed)
    && lifecycle.promotedArtifact?.artifact?.id) {
    try {
      await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id);
    } catch {
      artifactFailed = true;
    }
  }
  if (workspaceFailed || artifactFailed) {
    throw host(
      'PDF_ATTACHMENT_REMOVAL_CLEANUP_FAILED',
      'Attachment-removal processing could not clean its private workspace.',
      500,
    );
  }
}

export class PdfAttachmentRemovalService {
  #store;
  #poppler;
  #core;

  constructor({ store, poppler, core = CORE } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')
      || !poppler || typeof poppler.execute !== 'function'
      || !core || CORE_METHODS.some((name) => typeof core[name] !== 'function')) {
      throw new TypeError(
        'PdfAttachmentRemovalService requires fixed store, Poppler, and raw writer APIs.',
      );
    }
    this.#store = store;
    this.#poppler = poppler;
    this.#core = core;
  }

  async remove(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal.');
    }
    let request;
    try {
      request = this.#core.normalizePdfAttachmentRemoval(value);
    } catch (error) {
      throw host(
        'INVALID_PDF_ATTACHMENT_REMOVAL_OPTIONS',
        'Attachment-removal request is invalid.',
        400,
        error,
      );
    }
    const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) {
      throw host(
        'SOURCE_VERSION_MISMATCH',
        'Attachment-removal source digest does not match the current document.',
        409,
      );
    }
    if (source.size < 5 || source.size > MAX_PDF_ATTACHMENT_REMOVAL_SOURCE_BYTES) {
      throw host(
        'PDF_ATTACHMENT_REMOVAL_INPUT_TOO_LARGE',
        'Attachment removal is limited to non-empty 64 MiB documents.',
        413,
      );
    }
    const deadline = createDeadline(signal, 120_000);
    const lifecycle = {
      workspaces: [], sourceBytes: null, outputBytes: null,
      promotedArtifact: null, completed: false,
    };
    try {
      return await runPdfAttachmentRemovalJob({
        store: this.#store, poppler: this.#poppler, core: this.#core,
        documentId, source, request, deadline, lifecycle,
      });
    } catch (error) {
      if (deadline.timedOut) {
        throw host(
          'PDF_ATTACHMENT_REMOVAL_TIMEOUT',
          'Attachment removal exceeded its two-minute deadline.',
          504,
          error,
        );
      }
      if (signal?.aborted) {
        throw host('JOB_CANCELLED', 'Attachment removal was cancelled.', 499, error);
      }
      if (error instanceof HostError) throw error;
      if (error?.code === 'INVALID_PDF_ATTACHMENT_REMOVAL') {
        throw host(
          'PDF_ATTACHMENT_REMOVAL_SOURCE_UNSUPPORTED',
          'PDF is outside the bounded attachment-removal subset.',
          422,
          error,
        );
      }
      if (error?.code === 'INVALID_PDF_ATTACHMENT_REMOVAL_OUTPUT') {
        throw host(
          'PDF_ATTACHMENT_REMOVAL_OUTPUT_INVALID',
          'Separate raw attachment-removal inspection rejected the output.',
          502,
          error,
        );
      }
      throw host(
        'PDF_ATTACHMENT_REMOVAL_FAILED',
        'Local host could not create a verified attachment-free PDF.',
        502,
        error,
      );
    } finally {
      deadline.dispose();
      lifecycle.sourceBytes?.fill(0);
      lifecycle.outputBytes?.fill(0);
      await cleanup(this.#store, lifecycle);
    }
  }
}
