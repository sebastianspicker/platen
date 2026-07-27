import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chmod, lstat, open, readdir, unlink } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { HostError } from './host-error.mjs';
import {
  createDeadline,
  executeOfflineSignatureInspection,
  PNG_SIGNATURE,
  readRegularOutput,
} from './pdf-service-foundation.mjs';
import {
  inspectIncrementalMetadataContent,
  inspectIncrementalMetadataEnvelope,
  incrementalMetadataEnvelopeSupported,
  incrementalMetadataRunOptions,
} from './pdf-incremental-metadata-validation.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import {
  INCREMENTAL_PAGE_VECTOR_PROFILE,
  normalizeIncrementalPageVector,
} from './pdf-page-vector-contract.mjs';
import {
  inspectIncrementalPdfPageVector,
  writeIncrementalPdfPageVector,
} from './pdf-page-vector-writer.mjs';
import { runPageVectorUpdate } from './pdf-page-vector-job.mjs';

const MAX_JOB_MS = 2 * 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_SOURCE_BYTES + (1024 * 1024);
const BEFORE_FILES = Object.freeze(['input.pdf']);
const AFTER_FILES = Object.freeze(['input.pdf', 'output.pdf']);
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);
const PROOF_KEYS = Object.freeze([
  'profile', 'sourceBytes', 'outputBytes', 'appendedBytes', 'sourcePrefixPreserved',
  'revisionCount', 'previousXrefOffset', 'appendedXrefOffset', 'page', 'rect',
  'sourcePageObjectNumber', 'sourcePageGeneration', 'sourcePageReference',
  'vectorStreamObjectNumber', 'vectorStreamGeneration', 'effectiveSize',
  'rootPreserved', 'infoPreserved', 'idPolicy',
]);
const STORE_METHODS = Object.freeze([
  'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace',
  'cleanupJob', 'promotePdfArtifact', 'deleteArtifact',
]);
const CORE_METHODS = Object.freeze([
  'normalizeIncrementalPageVector',
  'writeIncrementalPdfPageVector',
  'inspectIncrementalPdfPageVector',
]);
const DEFAULT_CORE = Object.freeze({
  normalizeIncrementalPageVector,
  writeIncrementalPdfPageVector,
  inspectIncrementalPdfPageVector,
});

export const PDF_PAGE_VECTOR_LIMITATIONS = Object.freeze([
  'Only strict, unsigned, unencrypted, passive PDFs with a content-empty target page are accepted.',
  'The operation appends one black 1pt stroked rectangle to the selected page; it is not general vector editing.',
  'Historical source bytes remain present in the append-only revision, and this local evidence does not establish broader semantic or print-production equivalence.',
]);
export const PDF_PAGE_VECTOR_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-incremental-proof',
  'poppler-page-count-text-boxes', 'poppler-render-target-diff-other-pages-match',
  'pdfsig-output-unsigned', 'artifact-sha256',
]);

function fail(code, message, status = 502, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function checkedCore(core) {
  if (!core || CORE_METHODS.some((name) => typeof core[name] !== 'function')) {
    throw new TypeError('PdfPageVectorService requires the fixed raw page-vector core API.');
  }
  return core;
}

function checkedRequest(core, value) {
  try {
    return core.normalizeIncrementalPageVector(value);
  } catch (error) {
    if (error?.code === 'INVALID_INCREMENTAL_PAGE_VECTOR') {
      fail('INVALID_INCREMENTAL_PAGE_VECTOR_OPTIONS', 'The requested incremental page vector is invalid.', 400, error);
    }
    throw error;
  }
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason ?? new Error('Incremental page-vector processing was cancelled.');
}

function overlap(left, right) {
  return left.buffer === right.buffer
    && left.byteOffset < right.byteOffset + right.byteLength
    && right.byteOffset < left.byteOffset + left.byteLength;
}

function assertProof(proof, sourceLength, outputLength, request) {
  const keys = proof && typeof proof === 'object' && !Array.isArray(proof)
    ? Object.keys(proof) : [];
  const integer = (value, minimum, maximum) => Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
  const valid = keys.length === PROOF_KEYS.length
    && keys.every((key, index) => key === PROOF_KEYS[index])
    && proof.profile === INCREMENTAL_PAGE_VECTOR_PROFILE
    && proof.sourceBytes === sourceLength && proof.outputBytes === outputLength
    && proof.appendedBytes === outputLength - sourceLength
    && integer(sourceLength, 5, MAX_SOURCE_BYTES)
    && integer(outputLength, sourceLength + 1, MAX_OUTPUT_BYTES)
    && integer(proof.appendedBytes, 1, 1024 * 1024)
    && proof.sourcePrefixPreserved === true
    && integer(proof.revisionCount, 2, 32)
    && integer(proof.previousXrefOffset, 1, sourceLength - 1)
    && integer(proof.appendedXrefOffset, sourceLength, outputLength - 1)
    && proof.page === request.page
    && isDeepStrictEqual(proof.rect, request.rect)
    && integer(proof.sourcePageObjectNumber, 1, 999_999)
    && integer(proof.sourcePageGeneration, 0, 65_535)
    && typeof proof.sourcePageReference === 'string'
    && integer(proof.vectorStreamObjectNumber, 1, 999_999)
    && integer(proof.vectorStreamGeneration, 0, 65_535)
    && integer(proof.effectiveSize, 2, 999_999)
    && proof.rootPreserved === true && proof.infoPreserved === true
    && ['absent', 'permanent-preserved-changing-updated'].includes(proof.idPolicy);
  if (!valid) fail('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', 'The raw page-vector proof did not match the fixed append-only contract.');
  return proof;
}

async function assertWorkspace(workspace, expected) {
  const entries = (await readdir(workspace)).sort();
  if (!isDeepStrictEqual(entries, [...expected].sort())) {
    fail('INCREMENTAL_PAGE_VECTOR_WORKSPACE_INVALID', 'Incremental page-vector processing changed its private workspace topology.');
  }
  for (const entry of entries) {
    const metadata = await lstat(join(workspace, entry));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
      || (metadata.mode & 0o077) !== 0) {
      fail('INCREMENTAL_PAGE_VECTOR_WORKSPACE_INVALID', 'Incremental page-vector processing produced an unsafe workspace file.');
    }
  }
}

async function writePrivateOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_OUTPUT_BYTES) {
    fail('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', 'The incremental page-vector writer did not return a bounded PDF buffer.');
  }
  let handle = null;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(path, 0o400);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(path).catch(() => {});
    if (error instanceof HostError) throw error;
    fail('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', 'The incremental page-vector output could not be staged privately.', 502, error);
  }
}

async function readPdf(path, { source = false } = {}) {
  return readRegularOutput(path, {
    minimumBytes: source ? 5 : 64,
    maximumBytes: source ? MAX_SOURCE_BYTES : MAX_OUTPUT_BYTES,
    label: source ? 'Private incremental page-vector source' : 'Incremental page-vector PDF output',
  });
}

async function fileIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  return Object.freeze(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, metadata[key]])));
}

async function assertFileIdentity(path, expected) {
  const actual = await fileIdentity(path);
  if (IDENTITY_KEYS.some((key) => actual[key] !== expected[key])) {
    fail('INCREMENTAL_PAGE_VECTOR_WORKSPACE_INVALID', 'An incremental page-vector workspace file changed during validation.');
  }
}

async function snapshot({ poppler, input, workspace, signatureWorkspace, signal }) {
  const settled = await Promise.allSettled([
    inspectIncrementalMetadataEnvelope(poppler, input, workspace, signal),
    executeOfflineSignatureInspection(poppler, { input, nssDirectory: signatureWorkspace, signal }),
  ]);
  const rejected = settled.find(({ status }) => status === 'rejected');
  if (rejected) throw rejected.reason;
  const [envelope, signatures] = settled.map(({ value }) => value);
  if (!incrementalMetadataEnvelopeSupported(envelope, signatures)) {
    fail('INCREMENTAL_PAGE_VECTOR_SOURCE_UNSUPPORTED', 'Incremental page vectors require an unsigned, unencrypted PDF without forms, JavaScript, XMP, attachments, or URLs.', 422);
  }
  const content = await inspectIncrementalMetadataContent(
    poppler, input, workspace, signal, envelope.inspection.pageCount,
  );
  return Object.freeze({ envelope, signatures, content });
}

async function renderPage(poppler, input, prefix, workspace, signal, page) {
  const result = await poppler.execute('renderPagePng', {
    input, outputPrefix: prefix, page, maxDimension: 256,
  }, incrementalMetadataRunOptions(workspace, signal, 64 * 1024));
  if (String(result?.stderr ?? '').trim()) {
    fail('INCREMENTAL_PAGE_VECTOR_POPPLER_WARNING', 'Poppler reported a warning while validating the incremental page-vector PDF.', 422);
  }
  const bytes = await readRegularOutput(`${prefix}.png`, {
    minimumBytes: PNG_SIGNATURE.length,
    maximumBytes: 32 * 1024 * 1024,
    label: 'Incremental page-vector validation render',
  });
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', 'Poppler produced an invalid incremental page-vector render.');
  }
  return bytes;
}

async function assertRenders({ poppler, sourcePath, outputPath, workspace, signal, pageCount, targetPage }) {
  for (let page = 1; page <= pageCount; page += 1) {
    const sourcePrefix = join(workspace, `source-render-${page}`);
    const outputPrefix = join(workspace, `output-render-${page}`);
    try {
      const sourceRender = await renderPage(poppler, sourcePath, sourcePrefix, workspace, signal, page);
      const outputRender = await renderPage(poppler, outputPath, outputPrefix, workspace, signal, page);
      const equal = sourceRender.equals(outputRender);
      if (page === targetPage ? equal : !equal) {
        fail('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', page === targetPage
          ? `Incremental page-vector did not change the validation render of target page ${page}.`
          : `Incremental page-vector changed the validation render of non-target page ${page}.`);
      }
    } finally {
      await Promise.allSettled([unlink(`${sourcePrefix}.png`), unlink(`${outputPrefix}.png`)]);
    }
  }
}

function mapFailure(error, externalSignal, deadline) {
  if (deadline.timedOut) return new HostError('INCREMENTAL_PAGE_VECTOR_TIMEOUT', 'Incremental page-vector processing exceeded its two-minute deadline.', 504, { cause: error });
  if (externalSignal?.aborted) return new HostError('JOB_CANCELLED', 'Incremental page-vector processing was cancelled.', 499, { cause: error });
  if (error instanceof HostError) return error;
  if (error?.code === 'UNSUPPORTED_INCREMENTAL_PAGE_VECTOR_PDF') return new HostError('INCREMENTAL_PAGE_VECTOR_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded incremental page-vector subset.', 422, { cause: error });
  if (error?.code === 'INVALID_INCREMENTAL_PAGE_VECTOR_OUTPUT') return new HostError('INCREMENTAL_PAGE_VECTOR_OUTPUT_INVALID', 'The append-only page-vector output failed separate raw reinspection.', 502, { cause: error });
  return new HostError('INCREMENTAL_PAGE_VECTOR_FAILED', 'The local host could not create a verified append-only page-vector copy.', 502, { cause: error });
}

async function cleanupAfterJob({ store, workspaces, promotedArtifact, completed }) {
  const results = await Promise.allSettled(workspaces.map((workspace) => Promise.resolve().then(() => store.cleanupJob(workspace))));
  const workspaceFailed = results.some(({ status }) => status === 'rejected');
  let artifactFailed = false;
  if ((!completed || workspaceFailed) && promotedArtifact?.artifact?.id) {
    try { await store.deleteArtifact(promotedArtifact.artifact.id); } catch { artifactFailed = true; }
  }
  if (workspaceFailed || artifactFailed) {
    fail('INCREMENTAL_PAGE_VECTOR_CLEANUP_FAILED', 'Incremental page-vector processing could not clean its private workspace or artifact.', 500);
  }
}

function freezeResult(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeResult);
  return Object.freeze(value);
}

export class PdfPageVectorService {
  #store;
  #poppler;
  #core;

  constructor({ store, poppler, core = DEFAULT_CORE } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) {
      throw new TypeError('PdfPageVectorService requires a DocumentStore-compatible store.');
    }
    if (!poppler || typeof poppler.execute !== 'function') {
      throw new TypeError('PdfPageVectorService requires a Poppler adapter.');
    }
    this.#store = store;
    this.#poppler = poppler;
    this.#core = checkedCore(core);
  }

  async update(documentId, value, { sourceSha256, signal: externalSignal } = {}) {
    return runPageVectorUpdate({
      deps: {
        SHA256, MAX_SOURCE_BYTES, MAX_JOB_MS, BEFORE_FILES, AFTER_FILES,
        PDF_PAGE_VECTOR_VALIDATORS, PDF_PAGE_VECTOR_LIMITATIONS,
        checkedRequest, fail, createDeadline, throwIfAborted, overlap,
        assertProof, stagePrivateSourceCopy, assertWorkspace, snapshot, readPdf,
        writePrivateOutput, fileIdentity, assertFileIdentity, assertPrivateSourceCopy,
        assertRenders, createOperationProvenance, mapFailure, cleanupAfterJob, freezeResult,
      },
      store: this.#store, poppler: this.#poppler, core: this.#core,
      documentId, value, sourceSha256, externalSignal,
    });
  }
}

export function createPdfPageVectorService(options) {
  return new PdfPageVectorService(options);
}
