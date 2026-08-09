import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { chmod, open, readFile, unlink } from 'node:fs/promises';
import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { stagePrivateSourceCopy } from './private-source-copy.mjs';
import {
  FULL_PAGE_REDACTION_PROFILE,
  writeFullPageRedaction,
} from './pdf-full-page-redaction-writer.mjs';
import { writeInertPageAnnotation } from './professional-capability/inert-annotation-writer.mjs';
import {
  REDACTION_OVERLAY_LABEL_LIMITATIONS,
  REDACTION_OVERLAY_LABEL_PROFILE,
  normalizeRedactionOverlayLabelRequest,
  validateRedactionOverlayLabelResult,
} from '../../src/core/pdf-redaction-overlay-label-contract.js';

const MAX_JOB_MS = 120_000;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_SOURCE_BYTES + (2 * 1024 * 1024);
const SHA256 = /^[a-f0-9]{64}$/u;
const STORE_METHODS = Object.freeze([
  'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace',
  'cleanupJob', 'promotePdfArtifact', 'deleteArtifact',
]);

function host(code, message, status = 502, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function overlaps(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right)
    && left.buffer === right.buffer
    && left.byteOffset < right.byteOffset + right.byteLength
    && right.byteOffset < left.byteOffset + left.byteLength;
}

function abort(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Redaction overlay-label processing was cancelled.');
}

async function writePrivate(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAX_OUTPUT_BYTES) {
    throw host('REDACTION_OVERLAY_LABEL_OUTPUT_INVALID', 'The redaction overlay-label output is outside its bounded size.', 502);
  }
  let handle;
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
    throw host('REDACTION_OVERLAY_LABEL_OUTPUT_INVALID', 'The redaction overlay-label output could not be staged privately.', 502, error);
  }
}

function validFullPageProof(proof, request, outputSha256, sourceLength, outputLength) {
  return proof && typeof proof === 'object' && !Array.isArray(proof)
    && proof.profile === FULL_PAGE_REDACTION_PROFILE
    && proof.sourceSha256 === request.sourceSha256
    && proof.page === request.page
    && proof.closedRevision === true
    && proof.sourcePrefixPreserved === false
    && proof.priorRevisionsAbsent === true
    && proof.cropBoxFilled === true
    && proof.directEmptyResources === true
    && proof.supersededReferencesAbsent === true
    && Number.isSafeInteger(proof.blackStreamObjectNumber) && proof.blackStreamObjectNumber > 0
    && proof.outputSha256 === outputSha256
    && sourceLength >= 5 && outputLength >= 32;
}

function validAnnotationProof(proof, request, outputSha256, baseBytes, outputBytes, contentsSha256) {
  return proof && typeof proof === 'object' && !Array.isArray(proof)
    && proof.subtype === 'FreeText'
    && proof.page === request.page
    && proof.contentsSha256 === contentsSha256
    && proof.outputSha256 === outputSha256
    && proof.sourcePrefixPreserved === true
    && Array.isArray(proof.rect) && proof.rect.length === 4
    && proof.rect.every((value, index) => value === [72, 400, 220, 440][index])
    && outputBytes.subarray(0, baseBytes.length).equals(baseBytes);
}

async function cleanup(store, workspace, artifact, completed) {
  const failures = [];
  if (workspace) {
    try { await store.cleanupJob(workspace); } catch (error) { failures.push(error); }
  }
  if ((!completed || failures.length) && artifact?.id) {
    try { await store.deleteArtifact(artifact.id); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw host('REDACTION_OVERLAY_LABEL_CLEANUP_FAILED', 'Redaction overlay-label processing could not clean its private workspace or artifact.', 500, failures[0]);
}

export class PdfRedactionOverlayLabelService {
  #store;
  #redactionWriter;
  #annotationWriter;

  constructor({ store, redactionWriter = writeFullPageRedaction, annotationWriter = writeInertPageAnnotation } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function')) {
      throw new TypeError('PdfRedactionOverlayLabelService requires a DocumentStore-compatible store.');
    }
    if (typeof redactionWriter !== 'function' || typeof annotationWriter !== 'function') {
      throw new TypeError('PdfRedactionOverlayLabelService requires raw redaction and annotation writers.');
    }
    this.#store = store;
    this.#redactionWriter = redactionWriter;
    this.#annotationWriter = annotationWriter;
  }

  async apply(documentId, normalizedRequest, { signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request;
    try { request = normalizeRedactionOverlayLabelRequest(normalizedRequest); }
    catch (error) { throw error instanceof HostError ? error : host('INVALID_REDACTION_OVERLAY_LABEL_OPTIONS', 'The redaction overlay-label request is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId);
    if (!source || source.sha256 !== request.sourceSha256 || !SHA256.test(String(source.sha256 ?? ''))) {
      throw host('SOURCE_VERSION_MISMATCH', 'The redaction overlay-label source digest does not match the current document.', 409);
    }
    if (!Number.isSafeInteger(source.size) || source.size < 32 || source.size > MAX_SOURCE_BYTES) {
      throw host('REDACTION_OVERLAY_LABEL_INPUT_TOO_LARGE', 'Redaction overlay labels are limited to bounded local PDF sources.', 413);
    }
    const deadline = createDeadline(signal, MAX_JOB_MS);
    let workspace = null; let artifact = null; let completed = false;
    let sourceBytes = null; let baseBytes = null; let outputBytes = null;
    try {
      abort(deadline.signal);
      await this.#store.verifySource(documentId);
      workspace = await this.#store.createJobWorkspace(documentId);
      const sourcePath = join(workspace, 'source.pdf');
      const basePath = join(workspace, 'redacted-base.pdf');
      const outputPath = join(workspace, 'overlay-label.pdf');
      await stagePrivateSourceCopy({
        sourcePath: this.#store.getSourcePath(documentId),
        targetPath: sourcePath,
        expectedSha256: request.sourceSha256,
        expectedSize: source.size,
        maximumBytes: MAX_SOURCE_BYTES,
        signal: deadline.signal,
      });
      sourceBytes = await readFile(sourcePath);
      if (sourceBytes.length !== source.size || digest(sourceBytes) !== request.sourceSha256) {
        throw host('SOURCE_INTEGRITY_FAILED', 'The private redaction overlay-label source changed before processing.', 409);
      }
      await this.#store.verifySource(documentId);
      abort(deadline.signal);

      const redacted = this.#redactionWriter(sourceBytes, Object.freeze({
        profile: FULL_PAGE_REDACTION_PROFILE,
        sourceSha256: request.sourceSha256,
        page: request.page,
      }));
      baseBytes = redacted?.bytes;
      const baseDigest = Buffer.isBuffer(baseBytes) ? digest(baseBytes) : null;
      if (overlaps(baseBytes, sourceBytes) || !validFullPageProof(redacted?.proof, request, baseDigest, sourceBytes.length, baseBytes?.length ?? 0)) {
        throw host('REDACTION_OVERLAY_LABEL_OUTPUT_INVALID', 'The full-page redaction proof did not match the closed-base contract.', 502);
      }
      await writePrivate(basePath, baseBytes);
      baseBytes = await readFile(basePath);
      if (digest(baseBytes) !== baseDigest) throw host('REDACTION_OVERLAY_LABEL_OUTPUT_INVALID', 'The staged redaction base changed during validation.', 502);
      abort(deadline.signal);

      const contents = `REDACTION_LABEL:${request.label}`;
      const contentsSha256 = digest(Buffer.from(contents, 'utf8'));
      const annotated = this.#annotationWriter(baseBytes, Object.freeze({
        subtype: 'FreeText', contents, page: request.page, rect: Object.freeze([72, 400, 220, 440]),
      }));
      outputBytes = annotated?.bytes;
      const outputSha256 = Buffer.isBuffer(outputBytes) ? digest(outputBytes) : null;
      if (overlaps(outputBytes, baseBytes) || !validAnnotationProof(annotated?.proof, request, outputSha256, baseBytes, outputBytes, contentsSha256)) {
        throw host('REDACTION_OVERLAY_LABEL_OUTPUT_INVALID', 'The FreeText redaction label proof did not match the output contract.', 502);
      }
      await writePrivate(outputPath, outputBytes);
      outputBytes = await readFile(outputPath);
      if (digest(outputBytes) !== outputSha256) throw host('REDACTION_OVERLAY_LABEL_OUTPUT_INVALID', 'The staged overlay-label output changed during validation.', 502);
      await this.#store.verifySource(documentId);
      const current = this.#store.getDocument(documentId);
      if (!current || current.sha256 !== request.sourceSha256) throw host('SOURCE_INTEGRITY_FAILED', 'The source changed while creating the redaction overlay label.', 409);
      abort(deadline.signal);

      const operation = createOperationProvenance({
        type: 'pdf-redaction-overlay-label',
        inputs: [{ documentId, sha256: request.sourceSha256, role: 'source' }],
        parameters: { profile: REDACTION_OVERLAY_LABEL_PROFILE, page: request.page, labelContentsSha256: contentsSha256 },
        expected: { sourceUnchanged: true, fullPageContentRemoved: true, labelAnnotationStored: true },
        validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'closed-redaction-base', 'full-page-content-removed', 'free-text-label', 'label-contents-sha256', 'artifact-sha256'], outputSha256 },
      });
      const stem = basename(source.displayName ?? 'document.pdf', extname(source.displayName ?? 'document.pdf'));
      artifact = await this.#store.promotePdfArtifact(documentId, outputPath, {
        displayName: `${stem}-redaction-overlay-label.pdf`, operation, expectedSha256: outputSha256, signal: deadline.signal,
      });
      if (!artifact || artifact.id === documentId || artifact.documentId !== documentId || artifact.mediaType !== 'application/pdf' || artifact.sha256 !== outputSha256 || artifact.size !== outputBytes.length) {
        throw host('REDACTION_OVERLAY_LABEL_OUTPUT_INVALID', 'The promoted artifact is not bound to the validated overlay-label output.', 502);
      }
      await this.#store.verifySource(documentId);
      const postPromotionSource = this.#store.getDocument(documentId);
      if (!postPromotionSource || postPromotionSource.sha256 !== request.sourceSha256) {
        throw host('SOURCE_INTEGRITY_FAILED', 'The source changed after promoting the redaction overlay label.', 409);
      }
      abort(deadline.signal);
      const result = {
        kind: 'pdf-redaction-overlay-label', profile: REDACTION_OVERLAY_LABEL_PROFILE, documentId,
        sourceSha256: request.sourceSha256, page: request.page, label: request.label,
        labelContentsSha256: contentsSha256, artifact,
        evidence: {
          sourceDigestReverified: true, sourceUnchanged: true, fullPageContentRemoved: true,
          closedRedactionBase: true, labelAnnotationStored: true, labelContentsDigestBound: true,
          artifactDigestBound: true, localOnly: true,
        },
        limitations: REDACTION_OVERLAY_LABEL_LIMITATIONS,
      };
      let validated;
      try {
        validated = validateRedactionOverlayLabelResult(result, { documentId, sourceSha256: request.sourceSha256, request });
      } catch (error) {
        throw host('REDACTION_OVERLAY_LABEL_OUTPUT_INVALID', 'The redaction overlay-label result failed its source-bound contract validation.', 502, error);
      }
      completed = true;
      return validated;
    } catch (error) {
      if (deadline.timedOut) throw host('REDACTION_OVERLAY_LABEL_TIMEOUT', 'Redaction overlay-label processing exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted) throw host('JOB_CANCELLED', 'Redaction overlay-label processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      throw host('REDACTION_OVERLAY_LABEL_FAILED', 'The local host could not create a verified redaction overlay-label artifact.', 502, error);
    } finally {
      deadline.dispose();
      sourceBytes?.fill(0); baseBytes?.fill(0); outputBytes?.fill(0);
      await cleanup(this.#store, workspace, artifact, completed);
    }
  }
}

export const createPdfRedactionOverlayLabelService = (options) => new PdfRedactionOverlayLabelService(options);
