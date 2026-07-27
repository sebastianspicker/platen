import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chmod, lstat, open, readdir, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createDeadline, readRegularOutput } from './pdf-service-foundation.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import {
  PDF_LAYER_DEFAULTS_PROFILE,
  normalizePdfLayerDefaults,
} from './pdf-layer-defaults-contract.mjs';
import {
  inspectPdfLayerDefaults,
  writePdfLayerDefaults,
} from './pdf-layer-defaults-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_JOB_MS = 2 * 60_000;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_SOURCE_BYTES + (1024 * 1024);
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);
const BEFORE_FILES = Object.freeze(['input.pdf']);
const AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);
const STORE_METHODS = Object.freeze([
  'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace',
  'cleanupJob', 'promotePdfArtifact', 'deleteArtifact',
]);
const CORE_METHODS = Object.freeze([
  'normalizePdfLayerDefaults', 'writePdfLayerDefaults', 'inspectPdfLayerDefaults',
]);
const DEFAULT_CORE = Object.freeze({
  normalizePdfLayerDefaults, writePdfLayerDefaults, inspectPdfLayerDefaults,
});
const PROOF_KEYS = Object.freeze([
  'profile', 'sourceBytes', 'outputBytes', 'appendedBytes', 'sourcePrefixPreserved',
  'onlyCatalogChanged', 'revisionCount', 'groupCount', 'visible', 'catalogReference',
]);

export const PDF_LAYER_DEFAULTS_LIMITATIONS = Object.freeze([
  'Only the writer\'s bounded passive optional-content subset is accepted; malformed, encrypted, signed, active-content, tagged, form, attachment, and unsupported structures are rejected.',
  'The operation changes only the catalog optional-content default state in a classic append-only revision. It does not establish render, accessibility, semantic, or print-production equivalence.',
  'Historical source bytes remain present in the derived artifact and source signatures are not preserved.',
]);
export const PDF_LAYER_DEFAULTS_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-layer-defaults-proof',
  'raw-layer-defaults-reinspection', 'source-reverified', 'artifact-sha256',
]);

function fail(code, message, status = 502, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function checkedCore(core) {
  if (!core || CORE_METHODS.some((name) => typeof core[name] !== 'function')) {
    throw new TypeError('PdfLayerDefaultsService requires the fixed layer-defaults writer API.');
  }
  return core;
}

function checkedRequest(core, value, sourceSha256) {
  let candidate = value;
  if (value && typeof value === 'object' && !Object.hasOwn(value, 'sourceSha256')) {
    candidate = { ...value, sourceSha256 };
  }
  try {
    const request = core.normalizePdfLayerDefaults(candidate);
    if (request.sourceSha256 !== sourceSha256) {
      fail('SOURCE_VERSION_MISMATCH', 'The layer-defaults request source digest does not match the current document.', 409);
    }
    return request;
  } catch (error) {
    if (error instanceof HostError) throw error;
    if (error?.code === 'INVALID_PDF_LAYER_DEFAULTS') {
      fail('INVALID_PDF_LAYER_DEFAULTS_OPTIONS', 'The requested layer-defaults change is invalid.', 400, error);
    }
    throw error;
  }
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason ?? new Error('PDF layer-defaults processing was cancelled.');
}

function overlap(left, right) {
  return left.buffer === right.buffer
    && left.byteOffset < right.byteOffset + right.byteLength
    && right.byteOffset < left.byteOffset + left.byteLength;
}

function assertProof(proof, sourceLength, outputLength, request) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof)
    ? Object.keys(proof) : [];
  const validInteger = (value, minimum, maximum) => Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
  const validVisible = Array.isArray(proof?.visible)
    && proof.visible.length === proof.groupCount
    && proof.visible.every((value) => typeof value === 'boolean');
  const valid = keys.length === PROOF_KEYS.length
    && keys.every((key, index) => key === PROOF_KEYS[index])
    && proof.profile === PDF_LAYER_DEFAULTS_PROFILE
    && proof.sourceBytes === sourceLength
    && proof.outputBytes === outputLength
    && proof.appendedBytes === outputLength - sourceLength
    && validInteger(sourceLength, 5, MAX_SOURCE_BYTES)
    && validInteger(outputLength, sourceLength + 1, MAX_OUTPUT_BYTES)
    && validInteger(proof.appendedBytes, 1, MAX_OUTPUT_BYTES - 5)
    && proof.sourcePrefixPreserved === true
    && proof.onlyCatalogChanged === true
    && validInteger(proof.revisionCount, 2, 32)
    && validInteger(proof.groupCount, 1, 100)
    && validVisible
    && typeof proof.catalogReference === 'string'
    && /^\d+ \d+ R$/u.test(proof.catalogReference);
  if (!valid) fail('PDF_LAYER_DEFAULTS_OUTPUT_INVALID', 'The raw layer-defaults proof did not match the fixed append-only contract.');
  if (request.changes.some(({ groupIndex }) => groupIndex >= proof.groupCount)) {
    fail('PDF_LAYER_DEFAULTS_OUTPUT_INVALID', 'The raw layer-defaults proof omitted a requested optional-content group.');
  }
  return proof;
}

async function assertWorkspace(workspace, expected) {
  const entries = (await readdir(workspace)).sort();
  if (!isDeepStrictEqual(entries, [...expected].sort())) {
    fail('PDF_LAYER_DEFAULTS_WORKSPACE_INVALID', 'Layer-defaults processing changed its private workspace topology.');
  }
  for (const entry of entries) {
    const metadata = await lstat(join(workspace, entry));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
      || (metadata.mode & 0o077) !== 0) {
      fail('PDF_LAYER_DEFAULTS_WORKSPACE_INVALID', 'Layer-defaults processing produced an unsafe workspace file.');
    }
  }
}

async function fileIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  return Object.freeze(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, metadata[key]])));
}

async function assertFileIdentity(path, expected) {
  const actual = await fileIdentity(path);
  if (IDENTITY_KEYS.some((key) => actual[key] !== expected[key])) {
    fail('PDF_LAYER_DEFAULTS_WORKSPACE_INVALID', 'A layer-defaults workspace file changed during validation.');
  }
}

async function writePrivateOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.length > MAX_OUTPUT_BYTES) {
    fail('PDF_LAYER_DEFAULTS_OUTPUT_INVALID', 'The layer-defaults writer did not return a bounded PDF buffer.');
  }
  let handle = null;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(path).catch(() => {});
    if (error instanceof HostError) throw error;
    fail('PDF_LAYER_DEFAULTS_OUTPUT_INVALID', 'The layer-defaults output could not be staged privately.', 502, error);
  }
}

async function readPdf(path, { source = false } = {}) {
  return readRegularOutput(path, {
    minimumBytes: 5,
    maximumBytes: source ? MAX_SOURCE_BYTES : MAX_OUTPUT_BYTES,
    label: source ? 'Private layer-defaults source' : 'Layer-defaults PDF output',
  });
}

function mapFailure(error, externalSignal, deadline) {
  if (deadline.timedOut) return new HostError('PDF_LAYER_DEFAULTS_TIMEOUT', 'PDF layer-defaults processing exceeded its two-minute deadline.', 504, { cause: error });
  if (externalSignal?.aborted) return new HostError('JOB_CANCELLED', 'PDF layer-defaults processing was cancelled.', 499, { cause: error });
  if (error instanceof HostError) return error;
  if (error?.code === 'UNSUPPORTED_PDF_LAYER_DEFAULTS_PDF') return new HostError('PDF_LAYER_DEFAULTS_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded layer-defaults subset.', 422, { cause: error });
  if (error?.code === 'INVALID_PDF_LAYER_DEFAULTS_OUTPUT') return new HostError('PDF_LAYER_DEFAULTS_OUTPUT_INVALID', 'The layer-defaults output failed separate raw reinspection.', 502, { cause: error });
  if (error?.code === 'INVALID_PDF_LAYER_DEFAULTS') return new HostError('PDF_LAYER_DEFAULTS_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded layer-defaults subset.', 422, { cause: error });
  return new HostError('PDF_LAYER_DEFAULTS_FAILED', 'The local host could not create a verified layer-defaults PDF artifact.', 502, { cause: error });
}

async function cleanup(store, lifecycle) {
  const results = await Promise.allSettled(lifecycle.workspaces.reverse().map((workspace) => store.cleanupJob(workspace)));
  const workspaceFailed = results.some(({ status }) => status === 'rejected');
  let artifactFailed = false;
  if ((!lifecycle.completed || workspaceFailed) && lifecycle.promotedArtifact?.artifact?.id) {
    try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { artifactFailed = true; }
  }
  if (workspaceFailed || artifactFailed) {
    throw new HostError('PDF_LAYER_DEFAULTS_CLEANUP_FAILED', 'Layer-defaults processing could not clean its private workspace or artifact.', 500);
  }
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

export class PdfLayerDefaultsService {
  #store;
  #core;

  constructor({ store, core = DEFAULT_CORE } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) {
      throw new TypeError('PdfLayerDefaultsService requires a DocumentStore-compatible store.');
    }
    this.#store = store;
    this.#core = checkedCore(core);
  }

  async update(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    if (!SHA256.test(String(sourceSha256 ?? ''))) {
      fail('SOURCE_VERSION_MISMATCH', 'The layer-defaults source digest does not match the current document.', 409);
    }
    const source = this.#store.getDocument(documentId);
    if (sourceSha256 !== source.sha256) {
      fail('SOURCE_VERSION_MISMATCH', 'The layer-defaults source digest does not match the current document.', 409);
    }
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_SOURCE_BYTES) {
      fail('PDF_LAYER_DEFAULTS_INPUT_TOO_LARGE', 'Layer defaults are limited to non-empty 128 MiB documents.', 413);
    }
    const request = checkedRequest(this.#core, value, sourceSha256);
    const deadline = createDeadline(signal, MAX_JOB_MS);
    const lifecycle = {
      workspaces: [], sourceBytes: null, outputBytes: null, writtenBytes: null,
      promotedArtifact: null, completed: false,
    };
    try {
      throwIfAborted(deadline.signal);
      await this.#store.verifySource(documentId);
      const workspace = await this.#store.createJobWorkspace(documentId);
      lifecycle.workspaces.push(workspace);
      const inputPath = join(workspace, 'input.pdf');
      const outputPath = join(workspace, 'output.pdf');
      const inputIdentity = await stagePrivateSourceCopy({
        sourcePath: this.#store.getSourcePath(documentId), targetPath: inputPath,
        expectedSha256: source.sha256, expectedSize: source.size,
        maximumBytes: MAX_SOURCE_BYTES, signal: deadline.signal,
      });
      await assertWorkspace(workspace, BEFORE_FILES);
      lifecycle.sourceBytes = await readPdf(inputPath, { source: true });
      if (lifecycle.sourceBytes.length !== source.size
        || createHash('sha256').update(lifecycle.sourceBytes).digest('hex') !== source.sha256) {
        fail('SOURCE_INTEGRITY_FAILED', 'The private layer-defaults source changed before parsing.', 500);
      }
      throwIfAborted(deadline.signal);
      const written = this.#core.writePdfLayerDefaults(lifecycle.sourceBytes, request);
      lifecycle.writtenBytes = written?.bytes;
      if (!Buffer.isBuffer(lifecycle.writtenBytes) || overlap(lifecycle.writtenBytes, lifecycle.sourceBytes)
        || !written?.proof) {
        fail('PDF_LAYER_DEFAULTS_OUTPUT_INVALID', 'The raw layer-defaults writer returned an invalid result.');
      }
      assertProof(written.proof, lifecycle.sourceBytes.length, lifecycle.writtenBytes.length, request);
      if (!lifecycle.writtenBytes.subarray(0, lifecycle.sourceBytes.length).equals(lifecycle.sourceBytes)) {
        fail('PDF_LAYER_DEFAULTS_OUTPUT_INVALID', 'The raw layer-defaults writer changed the source prefix.');
      }
      throwIfAborted(deadline.signal);
      await writePrivateOutput(outputPath, lifecycle.writtenBytes);
      lifecycle.writtenBytes.fill(0); lifecycle.writtenBytes = null;
      await assertWorkspace(workspace, AFTER_FILES);
      lifecycle.outputBytes = await readPdf(outputPath);
      const outputIdentity = await fileIdentity(outputPath);
      const inspected = this.#core.inspectPdfLayerDefaults(lifecycle.sourceBytes, lifecycle.outputBytes, request);
      assertProof(inspected, lifecycle.sourceBytes.length, lifecycle.outputBytes.length, request);
      if (!isDeepStrictEqual(written.proof, inspected)
        || !lifecycle.outputBytes.subarray(0, lifecycle.sourceBytes.length).equals(lifecycle.sourceBytes)) {
        fail('PDF_LAYER_DEFAULTS_OUTPUT_INVALID', 'Separate raw reinspection disagreed with the layer-defaults writer proof.');
      }
      await assertFileIdentity(outputPath, outputIdentity);
      await assertPrivateSourceCopy({
        path: inputPath, identity: inputIdentity, expectedSha256: source.sha256,
        expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES,
      });
      await this.#store.verifySource(documentId);
      throwIfAborted(deadline.signal);
      const outputDigest = createHash('sha256').update(lifecycle.outputBytes).digest('hex');
      if (outputDigest === source.sha256) {
        fail('PDF_LAYER_DEFAULTS_OUTPUT_INVALID', 'The layer-defaults output did not produce a distinct artifact digest.');
      }
      const visibleGroupIndices = inspected.visible.flatMap((visible, index) => visible ? [index] : []);
      const hiddenGroupIndices = inspected.visible.flatMap((visible, index) => visible ? [] : [index]);
      const operation = createOperationProvenance({
        type: 'pdf-layer-defaults',
        inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
        parameters: { groupCount: inspected.groupCount, visibleGroupIndices, hiddenGroupIndices },
        expected: { groupCount: inspected.groupCount, sourceUnchanged: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, rasterized: false },
        validation: { passed: true, validators: PDF_LAYER_DEFAULTS_VALIDATORS, groupCount: inspected.groupCount, visibleGroupIndices, outputSha256: outputDigest },
      });
      const stem = basename(source.displayName, extname(source.displayName));
      const artifact = await this.#store.promotePdfArtifact(documentId, outputPath, {
        displayName: `${stem}-layer-defaults.pdf`, operation,
        expectedSha256: outputDigest, signal: deadline.signal,
      });
      lifecycle.promotedArtifact = freeze({
        kind: 'pdf-layer-defaults', sourceDigest: source.sha256, artifact,
        proof: { ...inspected, outputSha256: outputDigest },
        evidence: { sourceDigestReverified: true, sourcePrefixPreserved: true, onlyCatalogChanged: true, classicIncrementalRevisionAppended: true, outputUnsigned: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true },
        limitations: PDF_LAYER_DEFAULTS_LIMITATIONS,
      });
      if (lifecycle.promotedArtifact.artifact.sha256 !== outputDigest) {
        fail('PDF_LAYER_DEFAULTS_OUTPUT_INVALID', 'The promoted layer-defaults artifact does not match the validated output.');
      }
      throwIfAborted(deadline.signal);
      lifecycle.completed = true;
      return lifecycle.promotedArtifact;
    } catch (error) {
      throw mapFailure(error, signal, deadline);
    } finally {
      deadline.dispose();
      lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); lifecycle.writtenBytes?.fill(0);
      await cleanup(this.#store, lifecycle);
    }
  }
}

export function createPdfLayerDefaultsService(options) {
  return new PdfLayerDefaultsService(options);
}
