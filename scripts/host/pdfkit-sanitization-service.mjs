import { basename, extname, join } from 'node:path';
import { digestFile } from './document-store.mjs';
import { HostError } from './host-error.mjs';
import { executeOfflineSignatureInspection, parseNamedDestinations } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { promotePdfKitSanitizationArtifact } from './pdfkit-sanitization-artifact.mjs';
import { buildMetadataSanitizationRequest, receiptMatchesMetadataContract } from './pdfkit-sanitization-contract.mjs';
import { readClosedClassicPdfOutput } from './pdf-classic-closed-output.mjs';
import {
  assertPdfKitSanitizationIdentity, assertPdfKitSanitizationPng, assertPdfKitSanitizationWorkspace,
  inspectPdfKitSanitizationEnvelope, MAX_PDFKIT_SANITIZATION_SOURCE_BYTES,
  observedPdfKitMetadataCategories, pdfKitMetadataAbsent, pdfKitSanitizationFileIdentity,
  pdfKitSanitizationRunOptions,
  PDFKIT_SANITIZATION_AFTER_FILES, PDFKIT_SANITIZATION_BEFORE_FILES,
} from './pdfkit-sanitization-validation.mjs';

export const PDFKIT_METADATA_SANITIZATION_PROFILE = 'macos-pdfkit-metadata-sanitize-v1';
export const PDFKIT_METADATA_SANITIZATION_LIMITATIONS = Object.freeze([
  'This fixed profile removes document Info entries, custom Info entries, and catalog XMP only from a separate derived PDF.',
  'It rejects signatures, encryption, forms, tags, layers, name trees, page labels, active content, attachments, URLs, and unsupported page or catalog graphs instead of silently discarding them.',
  'This is not hidden-data sanitization, prior-revision or orphan-object scrubbing, secure erasure, signature preservation, or byte preservation.',
]);

const MAX_JOB_MS = 2 * 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const FIXED_LIMITS = Object.freeze({ maxPages: 100, maxAnnotationsPerPage: 50, maxWidgetsPerPage: 0, maxOutlineDepth: 8, maxOutlineItems: 200 });
function fail(code, message, status = 400) { throw new HostError(code, message, status); }

function createJobSignal(externalSignal) {
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
  const controller = new AbortController(); let timedOut = false;
  const onAbort = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', onAbort, { once: true }); if (externalSignal?.aborted) onAbort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('PDFKit metadata sanitization deadline exceeded.')); }, MAX_JOB_MS);
  timer.unref?.();
  return Object.freeze({ signal: controller.signal, get timedOut() { return timedOut; }, dispose() { clearTimeout(timer); externalSignal?.removeEventListener('abort', onAbort); } });
}

function sourceIsSupported(envelope, signatures) {
  const { inspection } = envelope;
  return inspection.pageCount <= FIXED_LIMITS.maxPages && String(inspection.encrypted).toLowerCase() === 'no'
    && String(inspection.form).toLowerCase() === 'none' && String(inspection.javascript).toLowerCase() === 'no'
    && String(inspection.tagged).toLowerCase() === 'no' && envelope.attachments.length === 0 && envelope.urls.length === 0
    && signatures.status === 'unsigned' && signatures.signatureCount === 0;
}

function outputIsSupported({ source, output, signatures, destinations }) {
  return output.inspection.pageCount === source.inspection.pageCount && String(output.inspection.encrypted).toLowerCase() === 'no'
    && String(output.inspection.form).toLowerCase() === 'none' && String(output.inspection.javascript).toLowerCase() === 'no'
    && String(output.inspection.tagged).toLowerCase() === 'no' && pdfKitMetadataAbsent(output.inspection, output.xmp, output.custom)
    && output.attachments.length === 0 && output.urls.length === 0 && destinations.items.length === 0
    && signatures.status === 'unsigned' && signatures.signatureCount === 0;
}

export class PdfKitSanitizationService {
  #store; #poppler; #adapter;
  constructor({ store, poppler, adapter } = {}) {
    if (!store || !['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact'].every((name) => typeof store[name] === 'function')) throw new TypeError('PdfKitSanitizationService requires a DocumentStore-compatible store.');
    if (!poppler || typeof poppler.execute !== 'function') throw new TypeError('PdfKitSanitizationService requires a Poppler adapter.');
    if (!adapter || typeof adapter.sanitizeMetadata !== 'function') throw new TypeError('PdfKitSanitizationService requires a PDFKit metadata-sanitization adapter.');
    this.#store = store; this.#poppler = poppler; this.#adapter = adapter;
  }

  async sanitizeMetadata(documentId, { sourceSha256, signal: externalSignal } = {}) {
    const source = this.#store.getDocument(documentId);
    if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) fail('SOURCE_VERSION_MISMATCH', 'The metadata-sanitization source digest does not match the current document.', 409);
    if (source.size < 1 || source.size > MAX_PDFKIT_SANITIZATION_SOURCE_BYTES) fail('PDFKIT_INPUT_TOO_LARGE', 'PDFKit metadata sanitization is limited to non-empty 128 MiB documents.', 413);
    const job = createJobSignal(externalSignal); let workspace = null; let signatureWorkspace = null; let nativeRequest = null; let promotedArtifact = null; let completed = false;
    try {
      await this.#store.verifySource(documentId); workspace = await this.#store.createJobWorkspace(documentId); signatureWorkspace = await this.#store.createJobWorkspace(documentId);
      const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
      const inputIdentity = await stagePrivateSourceCopy({ sourcePath: this.#store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDFKIT_SANITIZATION_SOURCE_BYTES });
      await assertPdfKitSanitizationWorkspace(workspace, PDFKIT_SANITIZATION_BEFORE_FILES);
      const [sourceEnvelope, sourceSignatures] = await Promise.all([
        inspectPdfKitSanitizationEnvelope(this.#poppler, inputPath, workspace, job.signal),
        executeOfflineSignatureInspection(this.#poppler, { input: inputPath, nssDirectory: signatureWorkspace, signal: job.signal }),
      ]);
      if (!sourceIsSupported(sourceEnvelope, sourceSignatures)) fail('PDFKIT_SANITIZATION_SOURCE_UNSUPPORTED', 'Metadata sanitization requires an unsigned, unencrypted, untagged PDF without forms, JavaScript, attachments, or external URLs.', 422);
      const categories = observedPdfKitMetadataCategories(sourceEnvelope.inspection, sourceEnvelope.xmp, sourceEnvelope.custom);
      if (categories.length === 0) fail('PDFKIT_SANITIZATION_NOT_REQUIRED', 'The fixed metadata categories are already absent.', 422);
      nativeRequest = buildMetadataSanitizationRequest(source.sha256, FIXED_LIMITS);
      const receipt = await this.#adapter.sanitizeMetadata({ workspacePath: workspace, requestBuffer: nativeRequest }, { signal: job.signal, timeoutMs: 30_000 }); nativeRequest.fill(0); nativeRequest = null;
      await assertPdfKitSanitizationWorkspace(workspace, PDFKIT_SANITIZATION_AFTER_FILES);
      await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDFKIT_SANITIZATION_SOURCE_BYTES });
      if (!receiptMatchesMetadataContract(receipt, source, categories, sourceEnvelope.inspection.pageCount)) fail('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'The native sanitization receipt did not match the fixed source contract.', 502);
      const outputIdentity = await pdfKitSanitizationFileIdentity(outputPath);
      let closedOutput;
      try { closedOutput = await readClosedClassicPdfOutput(outputPath, outputIdentity); } catch (error) {
        throw new HostError('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'The sanitized PDF is not a closed classic output.', 502, { cause: error });
      }
      const outputDigest = closedOutput.sha256;
      if (outputDigest !== receipt.outputSha256 || outputDigest === source.sha256) fail('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'The sanitized PDF digest did not match the native receipt.', 502);
      const [outputEnvelope, outputSignatures, destinationsResult] = await Promise.all([
        inspectPdfKitSanitizationEnvelope(this.#poppler, outputPath, workspace, job.signal), executeOfflineSignatureInspection(this.#poppler, { input: outputPath, nssDirectory: signatureWorkspace, signal: job.signal }),
        this.#poppler.execute('inspectDestinations', { input: outputPath }, pdfKitSanitizationRunOptions(workspace, job.signal)),
      ]);
      const destinations = parseNamedDestinations(destinationsResult.stdout, { pageCount: outputEnvelope.inspection.pageCount });
      if (!outputIsSupported({ source: sourceEnvelope, output: outputEnvelope, signatures: outputSignatures, destinations })) fail('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'Independent inspection found metadata or unsupported structure in the sanitized PDF.', 502);
      for (let page = 1; page <= receipt.pageCount; page += 1) { const outputPrefix = join(workspace, `validated-${page}`); await this.#poppler.execute('renderPagePng', { input: outputPath, outputPrefix, page, maxDimension: 256 }, pdfKitSanitizationRunOptions(workspace, job.signal, 64 * 1024)); const renderedPath = `${outputPrefix}.png`; await assertPdfKitSanitizationPng(renderedPath); await (await import('node:fs/promises')).unlink(renderedPath); }
      await assertPdfKitSanitizationWorkspace(workspace, PDFKIT_SANITIZATION_AFTER_FILES); await assertPdfKitSanitizationIdentity(outputPath, outputIdentity);
      if (await digestFile(outputPath) !== outputDigest) fail('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'The sanitized PDF changed during independent validation.', 502);
      await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDFKIT_SANITIZATION_SOURCE_BYTES }); await this.#store.verifySource(documentId);
      promotedArtifact = await promotePdfKitSanitizationArtifact({ store: this.#store, documentId, source, outputPath, outputDigest, categories, pageCount: sourceEnvelope.inspection.pageCount, signal: job.signal, profile: PDFKIT_METADATA_SANITIZATION_PROFILE, limitations: PDFKIT_METADATA_SANITIZATION_LIMITATIONS });
      if (promotedArtifact.artifact.sha256 !== outputDigest || promotedArtifact.artifact.id === source.id) fail('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'The promoted sanitized PDF does not match the validated output.', 502);
      completed = true; return promotedArtifact;
    } catch (error) {
      if (job.timedOut) throw new HostError('PDFKIT_SANITIZATION_TIMEOUT', 'PDFKit metadata sanitization exceeded its two-minute deadline.', 504, { cause: error });
      if (externalSignal?.aborted) throw new HostError('JOB_CANCELLED', 'PDFKit metadata sanitization was cancelled.', 499, { cause: error });
      if (error instanceof HostError) throw error;
      if (error?.code === 'INVALID_REQUEST') throw new HostError('INVALID_PDFKIT_SANITIZATION_OPTIONS', 'The pinned helper rejected the fixed metadata-sanitization request.', 400);
      if (error?.code === 'MUTATION_FAILED') throw new HostError('PDFKIT_SANITIZATION_SOURCE_UNSUPPORTED', 'The pinned helper rejected unsupported source structure or found no removable metadata.', 422);
      if (error?.code === 'OUTPUT_INVALID') throw new HostError('PDFKIT_SANITIZATION_OUTPUT_INVALID', 'The pinned helper could not prove the metadata-free derived copy.', 502, { cause: error });
      throw new HostError('PDFKIT_SANITIZATION_FAILED', 'The pinned local PDFKit helper could not create a verified metadata-free copy.', 502, { cause: error });
    } finally {
      nativeRequest?.fill(0); job.dispose(); const cleanups = [ ...(signatureWorkspace ? [() => this.#store.cleanupJob(signatureWorkspace)] : []), ...(workspace ? [() => this.#store.cleanupJob(workspace)] : []) ];
      const cleanupResults = await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve().then(cleanup))); const workspaceCleanupFailed = cleanupResults.some(({ status }) => status === 'rejected'); let artifactCleanupFailed = false;
      if ((!completed || workspaceCleanupFailed) && promotedArtifact?.artifact?.id) { try { await this.#store.deleteArtifact(promotedArtifact.artifact.id); } catch { artifactCleanupFailed = true; } }
      if (workspaceCleanupFailed || artifactCleanupFailed) throw new HostError('PDFKIT_SANITIZATION_CLEANUP_FAILED', 'PDFKit metadata sanitization could not clean its private workspace.', 500);
    }
  }
}
