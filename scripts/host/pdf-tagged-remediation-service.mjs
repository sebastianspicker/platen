import { createHash } from 'node:crypto';
import { chmod, lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { readRegularOutput } from './bounded-output-io.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import {
  normalizeTaggedPdfRemediationRequest,
  TAGGED_PDF_REMEDIATION_PROFILE,
} from './pdf-tagged-remediation-contract.mjs';
import {
  inspectTaggedPdfRemediation,
  writeTaggedPdfRemediation,
} from './pdf-tagged-remediation-writer.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_JOB_MS = 120_000;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_SOURCE_BYTES + (16 * 1024 * 1024);
const CORE = Object.freeze({ normalizeTaggedPdfRemediation: normalizeTaggedPdfRemediationRequest, writeTaggedPdfRemediation, inspectTaggedPdfRemediation });
const METHODS = Object.freeze([
  'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob',
  'promotePdfArtifact', 'deleteArtifact',
]);
const LIMITATIONS = Object.freeze([
  'This bounded local writer either edits a complete source-bound tag tree or adds a legacy candidate tree to a narrow passive PDF subset.',
  'It does not claim PDF/UA conformance, semantic reading-order correctness, or whole-document accessibility remediation.',
  'Existing-structure mode rejects prior revisions and unsupported links, tables, forms, annotations, active content, signatures, encryption, layers, and ambiguous content.',
]);
const VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'tagged-remediation-writer-proof',
  'tagged-remediation-independent-reinspection', 'artifact-sha256',
  'tag-tree-reinspection', 'page-geometry-content-evidence',
]);

function host(code, message, status = 502, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

function cancelled(signal) {
  if (signal.aborted) throw signal.reason ?? new Error('Tagged-PDF remediation was cancelled.');
}

function checkedCore(core) {
  if (!core || Object.keys(CORE).some((name) => typeof core[name] !== 'function')) {
    throw new TypeError('PdfTaggedRemediationService requires the fixed tagged-PDF writer API.');
  }
  return core;
}

function checkedRequest(core, value) {
  try {
    const normalized = core.normalizeTaggedPdfRemediation(value);
    const snapshot = structuredClone(normalized);
    const freeze = (entry) => {
      if (entry && typeof entry === 'object' && !Object.isFrozen(entry)) {
        Object.values(entry).forEach(freeze);
        Object.freeze(entry);
      }
      return entry;
    };
    return freeze(snapshot);
  } catch (error) {
    if (error?.code === 'INVALID_TAGGED_PDF_REMEDIATION_REQUEST') {
      throw host('INVALID_TAGGED_PDF_REMEDIATION_OPTIONS', 'The tagged-PDF remediation request is invalid.', 400, error);
    }
    throw error;
  }
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function writePrivateOutput(path, bytes, signal) {
  cancelled(signal);
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_OUTPUT_BYTES) {
    throw host('TAGGED_PDF_REMEDIATION_OUTPUT_INVALID', 'The tagged-PDF remediation output is not bounded.');
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
    throw host('TAGGED_PDF_REMEDIATION_OUTPUT_INVALID', 'The tagged-PDF remediation output could not be staged privately.', 502, error);
  }
}

async function identity(path) {
  const value = await lstat(path, { bigint: true });
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n || (value.mode & 0o777n) !== 0o400n) {
    throw host('TAGGED_PDF_REMEDIATION_OUTPUT_INVALID', 'The tagged-PDF remediation output is not a private single-link regular file.');
  }
  return Object.freeze({ dev: value.dev, ino: value.ino, size: value.size, mode: value.mode, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs });
}

async function assertIdentity(path, expected) {
  const actual = await identity(path);
  for (const key of Object.keys(expected)) if (actual[key] !== expected[key]) {
    throw host('TAGGED_PDF_REMEDIATION_OUTPUT_INVALID', 'The tagged-PDF remediation output changed during validation.');
  }
}

function assertProof(proof, sourceBytes, outputBytes, request, outputSha256) {
  if (!proof || Object.getPrototypeOf(proof) !== Object.prototype
    || proof.profile !== TAGGED_PDF_REMEDIATION_PROFILE
    || proof.sourceSha256 !== request.sourceSha256 || proof.outputSha256 !== outputSha256
    || proof.sourcePrefixPreserved !== true || proof.originalContentStreamsUnchanged !== true
    || proof.deterministic !== true || proof.structureLinked !== true
    || !Number.isSafeInteger(proof.pageCount) || proof.pageCount < 1 || proof.pageCount > 100
    || !Array.isArray(proof.pageGeometry) || proof.pageGeometry.length !== proof.pageCount
    || !Array.isArray(proof.originalContentStreams)
    || !Number.isSafeInteger(proof.appendedBytes) || proof.appendedBytes < 1
    || !Number.isSafeInteger(proof.revisionCount) || proof.revisionCount < 2
    || !Number.isSafeInteger(proof.structTreeRootObjectNumber) || proof.structTreeRootObjectNumber < 1
    || outputBytes.length <= sourceBytes.length || !outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes)) {
    throw host('TAGGED_PDF_REMEDIATION_OUTPUT_INVALID', 'The tagged-PDF remediation proof did not match the bounded output.');
  }
  if (request.plan.mode === 'existing-structure-v1' && (proof.tagTreeReinspected !== true
    || proof.textEvidence !== 'content-streams-unchanged'
    || proof.renderingEvidence !== 'page-geometry-and-content-preserved')) {
    throw host('TAGGED_PDF_REMEDIATION_OUTPUT_INVALID', 'Existing-structure remediation proof omitted independent tag, text, or rendering evidence.');
  }
}

async function cleanup(store, workspaces, promoted, complete) {
  const cleaned = await Promise.allSettled(workspaces.reverse().map((path) => store.cleanupJob(path)));
  const workspaceFailed = cleaned.some(({ status }) => status === 'rejected');
  let artifactFailed = false;
  if ((!complete || workspaceFailed) && promoted?.artifact?.id) {
    try { await store.deleteArtifact(promoted.artifact.id); } catch { artifactFailed = true; }
  }
  if (workspaceFailed || artifactFailed) {
    throw host('TAGGED_PDF_REMEDIATION_CLEANUP_FAILED', 'Tagged-PDF remediation could not clean its private workspace or artifact.', 500);
  }
}

export class PdfTaggedRemediationService {
  #store; #core;

  constructor({ store, core = CORE } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function')) {
      throw new TypeError('PdfTaggedRemediationService requires a DocumentStore-compatible store.');
    }
    this.#store = store;
    this.#core = checkedCore(core);
  }

  async update(documentId, value, { sourceSha256, signal: externalSignal } = {}) {
    if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal.');
    }
    const request = checkedRequest(this.#core, value);
    const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256
      || request.sourceSha256 !== source.sha256) {
      throw host('SOURCE_VERSION_MISMATCH', 'The tagged-PDF remediation source digest does not match the current document.', 409);
    }
    if (source.size < 5 || source.size > MAX_SOURCE_BYTES) {
      throw host('TAGGED_PDF_REMEDIATION_INPUT_TOO_LARGE', 'Tagged-PDF remediation is limited to non-empty 128 MiB documents.', 413);
    }
    const deadline = createDeadline(externalSignal, MAX_JOB_MS);
    const workspaces = [];
    let sourceBytes = null; let outputBytes = null; let writtenBytes = null;
    let promoted = null; let complete = false;
    try {
      cancelled(deadline.signal);
      await this.#store.verifySource(documentId);
      const workspace = await this.#store.createJobWorkspace(documentId);
      workspaces.push(workspace);
      const inputPath = join(workspace, 'input.pdf');
      const outputPath = join(workspace, 'output.pdf');
      const sourceIdentity = await stagePrivateSourceCopy({
        sourcePath: this.#store.getSourcePath(documentId), targetPath: inputPath,
        expectedSha256: source.sha256, expectedSize: source.size,
        maximumBytes: MAX_SOURCE_BYTES, signal: deadline.signal,
      });
      sourceBytes = await readRegularOutput(inputPath, {
        minimumBytes: 5, maximumBytes: MAX_SOURCE_BYTES, label: 'Private tagged-PDF remediation source',
      });
      if (sourceBytes.length !== source.size || digest(sourceBytes) !== source.sha256) {
        throw host('TAGGED_PDF_REMEDIATION_SOURCE_INVALID', 'The private tagged-PDF remediation source failed digest validation.', 500);
      }
      const written = this.#core.writeTaggedPdfRemediation(sourceBytes, request);
      writtenBytes = written?.bytes;
      if (!Buffer.isBuffer(writtenBytes) || !written?.proof) {
        throw host('TAGGED_PDF_REMEDIATION_OUTPUT_INVALID', 'The tagged-PDF remediation writer returned an invalid result.');
      }
      const outputSha256 = digest(writtenBytes);
      assertProof(written.proof, sourceBytes, writtenBytes, request, outputSha256);
      await writePrivateOutput(outputPath, writtenBytes, deadline.signal);
      writtenBytes.fill(0); writtenBytes = null;
      const outputIdentity = await identity(outputPath);
      outputBytes = await readRegularOutput(outputPath, {
        minimumBytes: 64, maximumBytes: MAX_OUTPUT_BYTES, label: 'Tagged-PDF remediation output',
      });
      const rereadDigest = digest(outputBytes);
      if (rereadDigest !== outputSha256) throw host('TAGGED_PDF_REMEDIATION_OUTPUT_INVALID', 'The tagged-PDF remediation output digest changed after staging.');
      const rawProof = this.#core.inspectTaggedPdfRemediation(sourceBytes, outputBytes, request);
      assertProof(rawProof, sourceBytes, outputBytes, request, rereadDigest);
      if (!isDeepStrictEqual(written?.proof ?? rawProof, rawProof)) {
        throw host('TAGGED_PDF_REMEDIATION_OUTPUT_INVALID', 'Independent tagged-PDF remediation inspection disagreed with the writer proof.');
      }
      await assertIdentity(outputPath, outputIdentity);
      await assertPrivateSourceCopy({ path: inputPath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES });
      await this.#store.verifySource(documentId);
      cancelled(deadline.signal);
      const planSha256 = digest(Buffer.from(JSON.stringify(request.plan), 'utf8'));
      const operation = createOperationProvenance({
        type: 'tagged-pdf-remediation',
        inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
        parameters: { profile: request.profile, mode: request.plan.mode ?? 'legacy-candidate-tree-v1', planSha256, language: request.language, title: request.title },
        expected: { pageCount: rawProof.pageCount, structureLinked: true, sourcePrefixPreserved: true },
        validation: {
          passed: true, validators: VALIDATORS,
          outputSha256: rereadDigest, proofOutputSha256: rawProof.outputSha256,
        },
      });
      promoted = await this.#store.promotePdfArtifact(documentId, outputPath, {
        displayName: 'tagged-pdf-remediation.pdf', operation,
        expectedSha256: rereadDigest, signal: deadline.signal,
      });
      if (!promoted?.id || promoted.sha256 !== rereadDigest || promoted.documentId !== documentId) {
        throw host('TAGGED_PDF_REMEDIATION_OUTPUT_INVALID', 'The promoted tagged-PDF remediation artifact is not source-bound.');
      }
      complete = true;
      return Object.freeze({
        kind: 'tagged-pdf-remediation', profile: TAGGED_PDF_REMEDIATION_PROFILE,
        sourceDigest: source.sha256, artifact: promoted, proof: rawProof,
        evidence: Object.freeze({ sourceBound: true, sourceUnchanged: true, outputDigestBound: true, independentInspection: true, localOnly: true }),
        limitations: LIMITATIONS,
      });
    } catch (error) {
      if (deadline.timedOut) throw host('TAGGED_PDF_REMEDIATION_TIMEOUT', 'Tagged-PDF remediation exceeded its two-minute deadline.', 504, error);
      if (externalSignal?.aborted) throw host('JOB_CANCELLED', 'Tagged-PDF remediation was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'UNSUPPORTED_TAGGED_PDF_REMEDIATION_PDF') throw host('TAGGED_PDF_REMEDIATION_SOURCE_UNSUPPORTED', 'The PDF is outside the supported bounded tagged-PDF remediation subset.', 422, error);
      if (error?.code === 'INVALID_TAGGED_PDF_REMEDIATION_OUTPUT') throw host('TAGGED_PDF_REMEDIATION_OUTPUT_INVALID', 'The tagged-PDF remediation output failed independent reinspection.', 502, error);
      throw host('TAGGED_PDF_REMEDIATION_FAILED', 'The local host could not create a verified tagged-PDF remediation copy.', 502, error);
    } finally {
      deadline.dispose(); sourceBytes?.fill(0); outputBytes?.fill(0); writtenBytes?.fill(0);
      await cleanup(this.#store, workspaces, promoted, complete);
    }
  }
}

export function createPdfTaggedRemediationService(options) { return new PdfTaggedRemediationService(options); }
