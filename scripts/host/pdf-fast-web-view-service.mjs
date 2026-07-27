import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { assertWorkspaceQuota } from './workspace-job-runtime.mjs';
import { digestFile } from './document-store-file-io.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import {
  normalizePdfFastWebView,
  PDF_FAST_WEB_VIEW_PROFILE,
  PDF_FAST_WEB_VIEW_VALIDATORS,
  PDF_FAST_WEB_VIEW_LIMITATIONS,
} from './pdf-fast-web-view-contract.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_JOB_MS = 3 * 60_000;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

function host(code, message, status = 502, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw host('JOB_CANCELLED', 'Fast web-view processing was cancelled.', 499, signal.reason);
}

function checkLinearizationDictionary(prefix, size) {
  const text = prefix.toString('latin1');
  const required = [
    /\/Linearized\s+1(?:\.0+)?\b/u,
    /\/L\s+(\d+)\b/u,
    /\/O\s+(\d+)\b/u,
    /\/E\s+(\d+)\b/u,
    /\/N\s+(\d+)\b/u,
    /\/T\s+(\d+)\b/u,
  ];
  if (required.some((pattern) => !pattern.test(text))) {
    throw host('INVALID_ENGINE_OUTPUT', 'qpdf output does not contain a complete linearization dictionary.', 502);
  }
  const declaredLength = Number(text.match(required[1])[1]);
  const endFirstPage = Number(text.match(required[3])[1]);
  if (!Number.isSafeInteger(declaredLength) || declaredLength !== size
    || !Number.isSafeInteger(endFirstPage) || endFirstPage <= 0 || endFirstPage > size) {
    throw host('INVALID_ENGINE_OUTPUT', 'qpdf output contains inconsistent linearization bounds.', 502);
  }
  return Object.freeze({ declaredLength, endFirstPage });
}

async function inspectLinearizedOutput(filePath) {
  let handle;
  try {
    const pathStat = await lstat(filePath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1
      || pathStat.size < 64 || pathStat.size > MAX_OUTPUT_BYTES) {
      throw host('INVALID_ENGINE_OUTPUT', 'qpdf did not produce a bounded single-link regular PDF.', 502);
    }
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.dev !== pathStat.dev
      || current.ino !== pathStat.ino || current.size !== pathStat.size) {
      throw host('INVALID_ENGINE_OUTPUT', 'qpdf output changed before validation.', 502);
    }
    const prefix = Buffer.alloc(Math.min(16 * 1024, current.size));
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (bytesRead !== prefix.length || prefix.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw host('INVALID_ENGINE_OUTPUT', 'qpdf output is not a PDF document.', 502);
    }
    const dictionary = checkLinearizationDictionary(prefix, current.size);
    const finalStat = await handle.stat();
    if (finalStat.size !== current.size || finalStat.mtimeMs !== current.mtimeMs
      || finalStat.ctimeMs !== current.ctimeMs) {
      throw host('INVALID_ENGINE_OUTPUT', 'qpdf output changed during validation.', 502);
    }
    return Object.freeze({ size: current.size, ...dictionary });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function cleanup(store, lifecycle) {
  const workspaces = lifecycle.workspaces.splice(0).reverse();
  const workspaceResults = await Promise.allSettled(workspaces.map((path) => store.cleanupJob(path)));
  const workspaceFailure = workspaceResults.find((entry) => entry.status === 'rejected')?.reason ?? null;
  const shouldRevoke = Boolean(lifecycle.promotedArtifact?.artifact?.id)
    && (!lifecycle.completed || workspaceFailure);
  let artifactFailure = null;
  if (shouldRevoke) {
    try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); }
    catch (error) { artifactFailure = error; }
  }
  if (workspaceFailure || artifactFailure) {
    const failures = [workspaceFailure, artifactFailure].filter(Boolean);
    const message = workspaceFailure && artifactFailure
      ? 'Fast web-view processing could not clean its private workspace or revoke the promoted artifact.'
      : workspaceFailure
        ? 'Fast web-view processing could not clean its private workspace after promotion.'
        : 'Fast web-view processing could not revoke its promoted artifact.';
    throw host(
      'PDF_FAST_WEB_VIEW_CLEANUP_FAILED', message, 500,
      new AggregateError(failures, message),
    );
  }
}

export class PdfFastWebViewService {
  #store;
  #qpdf;

  constructor({ store, qpdf } = {}) {
    if (!store || !['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']
      .every((name) => typeof store[name] === 'function') || !qpdf || typeof qpdf.probe !== 'function'
      || typeof qpdf.execute !== 'function') {
      throw new TypeError('PdfFastWebViewService requires a document store and qpdf adapter.');
    }
    this.#store = store;
    this.#qpdf = qpdf;
  }

  async probe() {
    try {
      const engine = await this.#qpdf.probe();
      return Object.freeze({ available: true, name: engine.name, version: engine.version });
    } catch (error) {
      return Object.freeze({ available: false, name: 'qpdf', version: null, reason: error?.code ?? 'ENGINE_UNAVAILABLE' });
    }
  }

  async linearize(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request;
    try { request = normalizePdfFastWebView(value); } catch (error) {
      throw host('INVALID_PDF_FAST_WEB_VIEW_OPTIONS', 'Fast web-view requires the fixed profile.', 400, error);
    }
    const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) {
      throw host('SOURCE_VERSION_MISMATCH', 'The fast web-view source digest does not match the current document.', 409);
    }
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_SOURCE_BYTES) {
      throw host('PDF_FAST_WEB_VIEW_INPUT_TOO_LARGE', 'Fast web-view is limited to bounded non-empty PDF documents.', 413);
    }
    let engine;
    try { engine = await this.#qpdf.probe(); } catch (error) {
      throw host('FAST_WEB_VIEW_UNAVAILABLE', 'The qpdf linearization engine is unavailable.', 503, error);
    }
    const deadline = createDeadline(signal, MAX_JOB_MS);
    const lifecycle = { workspaces: [], promotedArtifact: null, completed: false };
    try {
      const workspace = await this.#store.createJobWorkspace(documentId);
      lifecycle.workspaces.push(workspace);
      const input = this.#store.getSourcePath(documentId);
      const output = join(workspace, 'linearized.pdf');
      await this.#store.verifySource(documentId);
      await this.#qpdf.execute('linearize', { input, output, workspace }, {
        signal: deadline.signal, timeoutMs: MAX_JOB_MS,
        maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024,
      });
      throwIfAborted(deadline.signal);
      await assertWorkspaceQuota(workspace);
      const checked = await inspectLinearizedOutput(output);
      throwIfAborted(deadline.signal);
      await this.#qpdf.execute('checkLinearization', { input: output, workspace }, {
        signal: deadline.signal, timeoutMs: 30_000,
        maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024,
      });
      throwIfAborted(deadline.signal);
      const outputSha256 = await digestFile(output);
      throwIfAborted(deadline.signal);
      await this.#store.verifySource(documentId);
      const operation = createOperationProvenance({
        type: 'pdf-fast-web-view',
        inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
        parameters: { profile: request.profile },
        expected: { linearized: true, sourceUnchanged: true, pageRangeDelivery: 'not-proven' },
        validation: {
          passed: true, validators: PDF_FAST_WEB_VIEW_VALIDATORS,
          linearized: true, linearizationLength: checked.declaredLength, outputSha256,
        },
      });
      const promoted = await this.#store.promotePdfArtifact(documentId, output, {
        displayName: `${source.displayName.replace(/\.pdf$/iu, '')}-fast-web-view.pdf`,
        operation, expectedSha256: outputSha256, signal: deadline.signal,
      });
      lifecycle.promotedArtifact = { artifact: promoted };
      if (deadline.signal.aborted) throw host('JOB_CANCELLED', 'Fast web-view processing was cancelled.', 499);
      lifecycle.completed = true;
      return Object.freeze({
        kind: 'pdf-fast-web-view', sourceDigest: source.sha256,
        artifact: promoted, engine: Object.freeze({ name: engine.name, version: engine.version }),
        evidence: Object.freeze({
          sourceDigestReverified: true, qpdfLinearized: true, qpdfCheckLinearization: true,
          linearizationDictionaryValid: true, artifactDigestBound: true,
          sourceUnchanged: true, localOnly: true,
        }),
        limitations: PDF_FAST_WEB_VIEW_LIMITATIONS,
      });
    } catch (error) {
      if (deadline.timedOut || error?.code === 'ENGINE_TIMEOUT') throw host('PDF_FAST_WEB_VIEW_TIMEOUT', 'Fast web-view processing exceeded its three-minute deadline.', 504, error);
      if (signal?.aborted || error?.code === 'ENGINE_CANCELLED') throw host('JOB_CANCELLED', 'Fast web-view processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'ENGINE_NOT_FOUND' || error?.code === 'ENGINE_UNKNOWN') throw host('FAST_WEB_VIEW_UNAVAILABLE', 'The qpdf linearization engine is unavailable.', 503, error);
      throw host('PDF_FAST_WEB_VIEW_FAILED', 'The local qpdf engine could not create a verified linearized PDF.', 502, error);
    } finally {
      deadline.dispose();
      await cleanup(this.#store, lifecycle);
    }
  }

  create(...args) { return this.linearize(...args); }
}

export function createPdfFastWebViewService(options) { return new PdfFastWebViewService(options); }
