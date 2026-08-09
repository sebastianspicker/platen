import { basename, extname, join } from 'node:path';
import { chmod, open, readFile } from 'node:fs/promises';
import { createOperationProvenance } from './operation-provenance.mjs';
import { HostError } from './host-error.mjs';
import {
  exportCanonicalTextAnnotationXfdf,
  parseCanonicalTextAnnotationXfdf,
} from './professional-capability/annotation-xfdf-interchange.mjs';
import { writeInertPageAnnotation } from './professional-capability/inert-annotation-writer.mjs';
import {
  PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_LIMITS,
  PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_PROFILE,
  freeze,
  normalizeReviewAnnotationImportExport,
  sha256,
} from './pdf-review-annotation-import-export-contract.mjs';

const METHODS = Object.freeze(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact']);

function host(code, message, status = 502, cause) {
  return new HostError(code, message, status, cause ? { cause } : undefined);
}

function cancelled(signal) {
  if (signal?.aborted) throw host('JOB_CANCELLED', 'Review annotation import/export was cancelled.', 499);
}

async function writePrivateOutput(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, 0o400);
}

async function cleanup(store, workspace, artifact, completed) {
  const failures = [];
  if (workspace) {
    try { await store.cleanupJob(workspace); } catch (error) { failures.push(error); }
  }
  if ((!completed || failures.length) && artifact?.id) {
    try { await store.deleteArtifact(artifact.id); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw host('REVIEW_ANNOTATION_IMPORT_EXPORT_CLEANUP_FAILED', 'Review annotation import/export could not clean its private workspace or derived artifact.', 500, failures[0]);
}

function annotationReceipt(record, outputSha256) {
  return freeze({
    subtype: 'Text', page: record.page, rect: [...record.rect],
    contentsSha256: sha256(Buffer.from(record.contents, 'utf8')),
    ...(record.name === undefined ? {} : { nameSha256: sha256(Buffer.from(record.name, 'utf8')) }),
    outputSha256,
  });
}

export class PdfReviewAnnotationImportExportService {
  #store; #workspaceState; #clock;

  constructor({ store, workspaceState, clock = () => new Date().toISOString() } = {}) {
    if (!store || METHODS.some((name) => typeof store[name] !== 'function')) throw new TypeError('PdfReviewAnnotationImportExportService requires a DocumentStore-compatible store.');
    if (!workspaceState || typeof workspaceState.snapshot !== 'function') throw new TypeError('PdfReviewAnnotationImportExportService requires authoritative workspace state.');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
    this.#store = store; this.#workspaceState = workspaceState; this.#clock = clock;
  }

  async importExport(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request;
    try { request = normalizeReviewAnnotationImportExport(value); } catch (error) {
      if (error instanceof HostError) throw error;
      throw host('INVALID_REVIEW_ANNOTATION_IMPORT_EXPORT_OPTIONS', 'Review annotation import/export options are invalid.', 400, error);
    }
    const source = this.#store.getDocument(documentId);
    if (sourceSha256 !== request.sourceSha256 || source.sha256 !== request.sourceSha256) throw host('SOURCE_VERSION_MISMATCH', 'Review annotation source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 32 || source.size > PDF_REVIEW_ANNOTATION_IMPORT_EXPORT_LIMITS.maxSourceBytes) throw host('REVIEW_ANNOTATION_IMPORT_EXPORT_INPUT_TOO_LARGE', 'Review annotation import/export requires a bounded local PDF source.', 413);
    if (this.#workspaceState.snapshot(documentId).revision !== request.expectedRevision) throw host('REVISION_CONFLICT', 'Review annotation source revision is stale.', 409);
    cancelled(signal);
    let record;
    try { record = parseCanonicalTextAnnotationXfdf(request.xfdf); } catch (error) {
      throw error instanceof HostError ? error : host('INVALID_ANNOTATION_XFDF', 'XFDF is outside the canonical Text annotation subset.', 400, error);
    }
    const canonicalXfdf = exportCanonicalTextAnnotationXfdf(record);
    if (canonicalXfdf !== request.xfdf) throw host('INVALID_ANNOTATION_XFDF', 'XFDF must use the canonical Text annotation encoding.', 400);
    let workspace = null; let artifact = null; let sourceBytes = null; let outputBytes = null; let completed = false;
    try {
      await this.#store.verifySource(documentId);
      cancelled(signal);
      sourceBytes = await readFile(this.#store.getSourcePath(documentId));
      if (sha256(sourceBytes) !== source.sha256) throw host('SOURCE_INTEGRITY_FAILED', 'Review annotation source changed while preparing import.', 409);
      const written = writeInertPageAnnotation(sourceBytes, record);
      outputBytes = written.bytes;
      if (!outputBytes.subarray(0, sourceBytes.length).equals(sourceBytes) || written.proof.sourcePrefixPreserved !== true) throw host('REVIEW_ANNOTATION_IMPORT_EXPORT_OUTPUT_INVALID', 'The annotation writer did not preserve the source prefix.', 502);
      const outputSha256 = sha256(outputBytes);
      if (written.proof.outputSha256 !== outputSha256) throw host('REVIEW_ANNOTATION_IMPORT_EXPORT_OUTPUT_INVALID', 'The annotation writer returned an unbound output proof.', 502);
      cancelled(signal);
      workspace = await this.#store.createJobWorkspace(documentId);
      const outputPath = join(workspace, 'review-annotation-import.pdf');
      await writePrivateOutput(outputPath, outputBytes);
      await this.#store.verifySource(documentId);
      if (this.#store.getDocument(documentId).sha256 !== request.sourceSha256 || this.#workspaceState.snapshot(documentId).revision !== request.expectedRevision) throw host('REVISION_CONFLICT', 'Review annotation source changed while importing XFDF.', 409);
      const receipt = annotationReceipt(record, outputSha256);
      const operation = createOperationProvenance({
        type: 'pdf-review-annotation-import-export',
        inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
        parameters: { profile: request.profile, expectedRevision: request.expectedRevision, xfdfSha256: sha256(Buffer.from(canonicalXfdf, 'utf8')), annotation: receipt },
        expected: { outputSha256, sourceUnchanged: true, sourcePrefixPreserved: true, annotationSubtype: 'Text', canonicalXfdf: true },
        validation: { passed: true, validators: ['source-sha256', 'source-revision', 'canonical-xfdf-text-only', 'inert-annotation-writer-reinspection', 'source-prefix-preserved', 'artifact-sha256'], outputSha256 },
        completedAt: this.#clock(),
      });
      const stem = basename(source.displayName, extname(source.displayName));
      artifact = await this.#store.promotePdfArtifact(documentId, outputPath, { displayName: `${stem}-review-annotation.pdf`, operation, expectedSha256: outputSha256, signal });
      if (!artifact || artifact.id === documentId || artifact.documentId !== documentId || artifact.mediaType !== 'application/pdf' || artifact.sha256 !== outputSha256 || artifact.size !== outputBytes.length) throw host('REVIEW_ANNOTATION_IMPORT_EXPORT_OUTPUT_INVALID', 'The promoted review annotation artifact is not bound to the validated output.', 502);
      cancelled(signal);
      completed = true;
      return freeze({
        kind: 'pdf-review-annotation-import-export', sourceDigest: source.sha256, revision: request.expectedRevision,
        artifact, annotation: receipt, xfdf: canonicalXfdf,
        evidence: { sourceDigestReverified: true, sourceRevisionReverified: true, sourcePrefixPreserved: true, canonicalXfdfTextOnly: true, inertTextAnnotationReinspected: true, artifactDigestBound: true, sourceUnchanged: true, localOnly: true },
        limitations: ['Exactly one canonical XFDF Text annotation is imported into one eligible classic single-revision PDF.', 'FDF, general XFDF, multiple or non-Text annotations, indirect annotation arrays, existing active content, source mutation, and remote transport are not supported.', 'The source remains unchanged and the imported annotation is retained only in a separate derived PDF.'],
      });
    } catch (error) {
      if (signal?.aborted) throw host('JOB_CANCELLED', 'Review annotation import/export was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      throw host('REVIEW_ANNOTATION_IMPORT_EXPORT_FAILED', 'The local host could not create a verified review annotation artifact.', 502, error);
    } finally {
      sourceBytes?.fill(0); outputBytes?.fill(0);
      await cleanup(this.#store, workspace, artifact, completed);
    }
  }

  import(...args) { return this.importExport(...args); }
}

export const createPdfReviewAnnotationImportExportService = (options) => new PdfReviewAnnotationImportExportService(options);
