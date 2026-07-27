import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { normalizeIncrementalBleedBox } from './pdf-incremental-bleed-box-contract.mjs';
import {
  inspectIncrementalPdfBleedBox,
  writeIncrementalPdfBleedBox,
} from './pdf-incremental-bleed-box-writer.mjs';
import { runIncrementalBleedBoxJob } from './pdf-incremental-bleed-box-job.mjs';
import { MAX_INCREMENTAL_BLEED_BOX_SOURCE_BYTES } from './pdf-incremental-bleed-box-validation.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JOB_MS = 120_000;
const STORE_METHODS = Object.freeze([
  'getDocument',
  'getSourcePath',
  'verifySource',
  'createJobWorkspace',
  'cleanupJob',
  'promotePdfArtifact',
  'deleteArtifact',
]);
const CORE_METHODS = Object.freeze([
  'normalizeIncrementalBleedBox',
  'writeIncrementalPdfBleedBox',
  'inspectIncrementalPdfBleedBox',
]);
const DEFAULT_CORE = Object.freeze({
  normalizeIncrementalBleedBox,
  writeIncrementalPdfBleedBox,
  inspectIncrementalPdfBleedBox,
});

function fail(code, message, status = 502) {
  throw new HostError(code, message, status);
}

function checkedCore(core) {
  if (!core || CORE_METHODS.some((name) => typeof core[name] !== 'function')) {
    throw new TypeError('PdfIncrementalBleedBoxService requires the fixed raw bleed-box core API.');
  }
  return core;
}

function checkedRequest(core, value) {
  try {
    return core.normalizeIncrementalBleedBox(value);
  } catch (error) {
    if (error?.code === 'INVALID_INCREMENTAL_BLEED_BOX') {
      throw new HostError(
        'INVALID_INCREMENTAL_BLEED_BOX_OPTIONS',
        'The requested incremental BleedBox is invalid.',
        400,
        { cause: error },
      );
    }
    throw error;
  }
}

function assertSourceRequest(source, sourceSha256) {
  if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) {
    fail(
      'SOURCE_VERSION_MISMATCH',
      'The incremental BleedBox source digest does not match the current document.',
      409,
    );
  }
  if (source.size < 5 || source.size > MAX_INCREMENTAL_BLEED_BOX_SOURCE_BYTES) {
    fail(
      'INCREMENTAL_BLEED_BOX_INPUT_TOO_LARGE',
      'Incremental BleedBox editing is limited to non-empty 128 MiB documents.',
      413,
    );
  }
}

function mapFailure(error, externalSignal, deadline) {
  if (deadline.timedOut) {
    return new HostError(
      'INCREMENTAL_BLEED_BOX_TIMEOUT',
      'Incremental BleedBox processing exceeded its two-minute deadline.',
      504,
      { cause: error },
    );
  }
  if (externalSignal?.aborted) {
    return new HostError(
      'JOB_CANCELLED',
      'Incremental BleedBox processing was cancelled.',
      499,
      { cause: error },
    );
  }
  if (error instanceof HostError) return error;
  if (error?.code === 'INVALID_INCREMENTAL_BLEED_BOX') {
    return new HostError(
      'INVALID_INCREMENTAL_BLEED_BOX_OPTIONS',
      'The requested incremental BleedBox is invalid.',
      400,
      { cause: error },
    );
  }
  if (error?.code === 'UNSUPPORTED_INCREMENTAL_BLEED_BOX_PDF') {
    return new HostError(
      'INCREMENTAL_BLEED_BOX_SOURCE_UNSUPPORTED',
      'The PDF is outside the supported bounded incremental BleedBox subset.',
      422,
      { cause: error },
    );
  }
  if (error?.code === 'INVALID_INCREMENTAL_BLEED_BOX_OUTPUT') {
    return new HostError(
      'INCREMENTAL_BLEED_BOX_OUTPUT_INVALID',
      'The append-only BleedBox output failed separate raw reinspection.',
      502,
      { cause: error },
    );
  }
  return new HostError(
    'INCREMENTAL_BLEED_BOX_FAILED',
    'The local host could not create a verified append-only BleedBox copy.',
    502,
    { cause: error },
  );
}

async function cleanupAfterJob({ store, lifecycle }) {
  const outcomes = await Promise.allSettled(lifecycle.workspaces.reverse().map(
    (workspace) => Promise.resolve().then(() => store.cleanupJob(workspace)),
  ));
  const workspaceCleanupFailed = outcomes.some(({ status }) => status === 'rejected');
  let artifactCleanupFailed = false;
  if ((!lifecycle.completed || workspaceCleanupFailed)
    && lifecycle.promotedArtifact?.artifact?.id) {
    try {
      await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id);
    } catch {
      artifactCleanupFailed = true;
    }
  }
  if (workspaceCleanupFailed || artifactCleanupFailed) {
    fail(
      'INCREMENTAL_BLEED_BOX_CLEANUP_FAILED',
      'Incremental BleedBox processing could not clean its private workspace.',
      500,
    );
  }
}

export class PdfIncrementalBleedBoxService {
  #store;
  #poppler;
  #core;

  constructor({ store, poppler, core = DEFAULT_CORE } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) {
      throw new TypeError(
        'PdfIncrementalBleedBoxService requires a DocumentStore-compatible store.',
      );
    }
    if (!poppler || typeof poppler.execute !== 'function') {
      throw new TypeError('PdfIncrementalBleedBoxService requires a Poppler adapter.');
    }
    this.#store = store;
    this.#poppler = poppler;
    this.#core = checkedCore(core);
  }

  async update(documentId, value, { sourceSha256, signal: externalSignal } = {}) {
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal.');
    }
    const request = checkedRequest(this.#core, value);
    const source = this.#store.getDocument(documentId);
    assertSourceRequest(source, sourceSha256);
    const deadline = createDeadline(externalSignal, MAX_JOB_MS);
    const lifecycle = {
      workspaces: [],
      sourceBytes: null,
      outputBytes: null,
      promotedArtifact: null,
      completed: false,
    };
    try {
      return await runIncrementalBleedBoxJob({
        store: this.#store,
        poppler: this.#poppler,
        core: this.#core,
        documentId,
        source,
        request,
        deadline,
        lifecycle,
      });
    } catch (error) {
      throw mapFailure(error, externalSignal, deadline);
    } finally {
      deadline.dispose();
      lifecycle.sourceBytes?.fill(0);
      lifecycle.outputBytes?.fill(0);
      await cleanupAfterJob({ store: this.#store, lifecycle });
    }
  }
}
