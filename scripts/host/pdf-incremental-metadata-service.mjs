import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createDeadline, executeOfflineSignatureInspection } from './pdf-service-foundation.mjs';
import { normalizeIncrementalMetadata } from './pdf-incremental-metadata-contract.mjs';
import {
  inspectIncrementalPdfMetadata,
  writeIncrementalPdfMetadata,
} from './pdf-incremental-metadata-writer.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { promoteIncrementalMetadataArtifact } from './pdf-incremental-metadata-artifact.mjs';
import {
  assertIncrementalMetadataFileIdentity,
  assertIncrementalMetadataProof,
  assertIncrementalMetadataRendersMatch,
  assertIncrementalMetadataWorkspace,
  incrementalMetadataContentMatches,
  incrementalMetadataEnvelopeSupported,
  incrementalMetadataFileIdentity,
  incrementalMetadataOutputMatches,
  inspectIncrementalMetadataContent,
  inspectIncrementalMetadataEnvelope,
  INCREMENTAL_METADATA_AFTER_FILES,
  INCREMENTAL_METADATA_BEFORE_FILES,
  MAX_INCREMENTAL_METADATA_SOURCE_BYTES,
  readStableIncrementalMetadataOutput,
  readStableIncrementalMetadataSource,
  writePrivateIncrementalMetadataOutput,
} from './pdf-incremental-metadata-validation.mjs';

const MAX_JOB_MS = 2 * 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_CORE = Object.freeze({
  normalizeIncrementalMetadata,
  writeIncrementalPdfMetadata,
  inspectIncrementalPdfMetadata,
});

function fail(code, message, status = 502) {
  throw new HostError(code, message, status);
}

function checkedCore(core) {
  const names = ['normalizeIncrementalMetadata', 'writeIncrementalPdfMetadata', 'inspectIncrementalPdfMetadata'];
  if (!core || names.some((name) => typeof core[name] !== 'function')) {
    throw new TypeError('PdfIncrementalMetadataService requires the fixed raw metadata core API.');
  }
  return core;
}

function checkedMetadata(core, value) {
  try {
    return core.normalizeIncrementalMetadata(value);
  } catch (error) {
    if (error?.code === 'INVALID_INCREMENTAL_METADATA') {
      throw new HostError('INVALID_INCREMENTAL_METADATA_OPTIONS', 'The standard metadata fields are invalid.', 400, { cause: error });
    }
    throw error;
  }
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason ?? new Error('Incremental metadata processing was cancelled.');
}

async function inspectSupportedSnapshot({ poppler, input, workspace, signatureWorkspace, signal }) {
  const settled = await Promise.allSettled([
    inspectIncrementalMetadataEnvelope(poppler, input, workspace, signal),
    executeOfflineSignatureInspection(poppler, { input, nssDirectory: signatureWorkspace, signal }),
  ]);
  const rejected = settled.find(({ status }) => status === 'rejected');
  if (rejected) throw rejected.reason;
  const [envelope, signatures] = settled.map(({ value }) => value);
  if (!incrementalMetadataEnvelopeSupported(envelope, signatures)) {
    fail('INCREMENTAL_METADATA_SOURCE_UNSUPPORTED', 'Incremental metadata editing requires an unsigned, unencrypted PDF without forms, JavaScript, XMP, attachments, or URLs.', 422);
  }
  const content = await inspectIncrementalMetadataContent(
    poppler, input, workspace, signal, envelope.inspection.pageCount,
  );
  return Object.freeze({ envelope, signatures, content });
}

function mapFailure(error, externalSignal, deadline) {
  if (deadline.timedOut) return new HostError('INCREMENTAL_METADATA_TIMEOUT', 'Incremental metadata processing exceeded its two-minute deadline.', 504, { cause: error });
  if (externalSignal?.aborted) return new HostError('JOB_CANCELLED', 'Incremental metadata processing was cancelled.', 499, { cause: error });
  if (error instanceof HostError) return error;
  if (error?.code === 'INVALID_INCREMENTAL_METADATA') return new HostError('INVALID_INCREMENTAL_METADATA_OPTIONS', 'The standard metadata fields are invalid.', 400, { cause: error });
  if (error?.code === 'UNSUPPORTED_INCREMENTAL_METADATA_PDF') return new HostError('INCREMENTAL_METADATA_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded incremental metadata subset.', 422, { cause: error });
  if (error?.code === 'INVALID_INCREMENTAL_METADATA_OUTPUT') return new HostError('INCREMENTAL_METADATA_OUTPUT_INVALID', 'The append-only metadata output failed separate raw reinspection.', 502, { cause: error });
  return new HostError('INCREMENTAL_METADATA_FAILED', 'The local host could not create a verified append-only metadata copy.', 502, { cause: error });
}

async function cleanupAfterJob({ store, workspaces, promotedArtifact, completed }) {
  const results = await Promise.allSettled(workspaces.map(
    (workspace) => Promise.resolve().then(() => store.cleanupJob(workspace)),
  ));
  const workspaceCleanupFailed = results.some(({ status }) => status === 'rejected');
  let artifactCleanupFailed = false;
  if ((!completed || workspaceCleanupFailed) && promotedArtifact?.artifact?.id) {
    try { await store.deleteArtifact(promotedArtifact.artifact.id); } catch { artifactCleanupFailed = true; }
  }
  if (workspaceCleanupFailed || artifactCleanupFailed) {
    fail('INCREMENTAL_METADATA_CLEANUP_FAILED', 'Incremental metadata processing could not clean its private workspace.', 500);
  }
}

export class PdfIncrementalMetadataService {
  #store; #poppler; #core;

  constructor({ store, poppler, core = DEFAULT_CORE } = {}) {
    const storeMethods = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact'];
    if (!store || storeMethods.some((name) => typeof store[name] !== 'function')) {
      throw new TypeError('PdfIncrementalMetadataService requires a DocumentStore-compatible store.');
    }
    if (!poppler || typeof poppler.execute !== 'function') {
      throw new TypeError('PdfIncrementalMetadataService requires a Poppler adapter.');
    }
    this.#store = store;
    this.#poppler = poppler;
    this.#core = checkedCore(core);
  }

  async update(documentId, metadata, { sourceSha256, signal: externalSignal } = {}) {
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal.');
    }
    const normalized = checkedMetadata(this.#core, metadata);
    const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) {
      fail('SOURCE_VERSION_MISMATCH', 'The incremental metadata source digest does not match the current document.', 409);
    }
    if (source.size < 5 || source.size > MAX_INCREMENTAL_METADATA_SOURCE_BYTES) {
      fail('INCREMENTAL_METADATA_INPUT_TOO_LARGE', 'Incremental metadata editing is limited to non-empty 128 MiB documents.', 413);
    }
    const deadline = createDeadline(externalSignal, MAX_JOB_MS);
    const workspaces = [];
    let sourceBytes = null;
    let writtenBytes = null;
    let outputBytes = null;
    let promotedArtifact = null;
    let completed = false;
    try {
      throwIfAborted(deadline.signal);
      await this.#store.verifySource(documentId);
      const workspace = await this.#store.createJobWorkspace(documentId); workspaces.push(workspace);
      const signatureWorkspace = await this.#store.createJobWorkspace(documentId); workspaces.push(signatureWorkspace);
      const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
      const inputIdentity = await stagePrivateSourceCopy({ sourcePath: this.#store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_INCREMENTAL_METADATA_SOURCE_BYTES });
      await assertIncrementalMetadataWorkspace(workspace, INCREMENTAL_METADATA_BEFORE_FILES);
      const sourceSnapshot = await inspectSupportedSnapshot({ poppler: this.#poppler, input: inputPath, workspace, signatureWorkspace, signal: deadline.signal });
      if (incrementalMetadataOutputMatches(sourceSnapshot.envelope, sourceSnapshot.envelope, normalized)) {
        fail('INVALID_INCREMENTAL_METADATA_OPTIONS', 'The requested standard metadata already matches the source document.', 400);
      }
      sourceBytes = await readStableIncrementalMetadataSource(inputPath, source.size); throwIfAborted(deadline.signal);
      const written = await this.#core.writeIncrementalPdfMetadata(sourceBytes, normalized);
      writtenBytes = written?.bytes;
      if (!Buffer.isBuffer(writtenBytes) || !written?.proof) fail('INCREMENTAL_METADATA_OUTPUT_INVALID', 'The raw incremental metadata writer returned an invalid result.');
      assertIncrementalMetadataProof(written.proof, sourceBytes.length, writtenBytes.length);
      if (!writtenBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) fail('INCREMENTAL_METADATA_OUTPUT_INVALID', 'The raw incremental metadata writer changed the source prefix.');
      throwIfAborted(deadline.signal); await writePrivateIncrementalMetadataOutput(outputPath, writtenBytes); writtenBytes.fill(0); writtenBytes = null;
      const outputIdentity = await incrementalMetadataFileIdentity(outputPath);
      await assertIncrementalMetadataWorkspace(workspace, INCREMENTAL_METADATA_AFTER_FILES);
      outputBytes = await readStableIncrementalMetadataOutput(outputPath);
      const reinspectionProof = await this.#core.inspectIncrementalPdfMetadata(sourceBytes, outputBytes, normalized);
      assertIncrementalMetadataProof(reinspectionProof, sourceBytes.length, outputBytes.length);
      if (!isDeepStrictEqual(written.proof, reinspectionProof) || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) fail('INCREMENTAL_METADATA_OUTPUT_INVALID', 'Separate raw reinspection disagreed with the incremental writer proof.');
      const outputSnapshot = await inspectSupportedSnapshot({ poppler: this.#poppler, input: outputPath, workspace, signatureWorkspace, signal: deadline.signal });
      if (!incrementalMetadataOutputMatches(sourceSnapshot.envelope, outputSnapshot.envelope, normalized)) fail('INCREMENTAL_METADATA_OUTPUT_INVALID', 'Poppler did not observe the exact requested standard metadata and page count.');
      if (!incrementalMetadataContentMatches(sourceSnapshot.content, outputSnapshot.content)) fail('INCREMENTAL_METADATA_OUTPUT_INVALID', 'Incremental metadata changed page text or page-box geometry.');
      await assertIncrementalMetadataRendersMatch({ poppler: this.#poppler, sourcePath: inputPath, outputPath, workspace, signal: deadline.signal, pageCount: sourceSnapshot.envelope.inspection.pageCount });
      await assertIncrementalMetadataWorkspace(workspace, INCREMENTAL_METADATA_AFTER_FILES);
      await assertIncrementalMetadataFileIdentity(outputPath, outputIdentity);
      const outputDigest = createHash('sha256').update(outputBytes).digest('hex');
      if (outputDigest === source.sha256) fail('INCREMENTAL_METADATA_OUTPUT_INVALID', 'The incremental metadata output did not produce a distinct artifact digest.');
      await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_INCREMENTAL_METADATA_SOURCE_BYTES });
      await this.#store.verifySource(documentId); throwIfAborted(deadline.signal);
      promotedArtifact = await promoteIncrementalMetadataArtifact({ store: this.#store, documentId, source, outputPath, outputDigest, pageCount: sourceSnapshot.envelope.inspection.pageCount, signal: deadline.signal });
      if (promotedArtifact.artifact.sha256 !== outputDigest || promotedArtifact.artifact.id === source.id) fail('INCREMENTAL_METADATA_OUTPUT_INVALID', 'The promoted incremental metadata artifact does not match the validated output.');
      throwIfAborted(deadline.signal);
      completed = true;
      return promotedArtifact;
    } catch (error) {
      throw mapFailure(error, externalSignal, deadline);
    } finally {
      deadline.dispose();
      sourceBytes?.fill(0); writtenBytes?.fill(0); outputBytes?.fill(0);
      await cleanupAfterJob({ store: this.#store, workspaces: workspaces.reverse(), promotedArtifact, completed });
    }
  }
}
