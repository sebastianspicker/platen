import { basename, extname, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { digestFile } from './document-store.mjs';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { inspectAnySupportedPdfKitAes128Envelope, inspectUnencryptedClassicPdfEnvelope } from './pdf-encryption-envelope.mjs';
import { parseAttachments, parseDocumentUrls, parsePdfInfo } from './pdf-service-foundation.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { deriveProtectedArtifactProfile, normalizeProtectionRemovalRequest, PDFKIT_PROTECTION_REMOVAL_PROFILE, protectionRemovalReceiptMatches, serializeProtectionRemovalRequest } from './pdfkit-protection-contract.mjs';
import { AFTER_FILES, BEFORE_FILES, MAX_OUTPUT_BYTES, SHA256, assertIdentity, assertPng, assertWorkspace, createJobSignal, fail, fileIdentity, freezeResult, promoteValidatedPdfArtifact, readStableOutput } from './pdfkit-protection-pipeline.mjs';

export async function removePdfKitProtection({ store, poppler, adapter }, documentId, removalInput, { sourceSha256, signal: externalSignal } = {}) {
  const document = store.getDocument(documentId);
  if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== document.sha256) fail('SOURCE_VERSION_MISMATCH', 'The protection-removal source digest does not match the current document.', 409);
  const normalized = normalizeProtectionRemovalRequest(removalInput);
  const protectedArtifact = store.getArtifact(normalized.artifactId);
  if (protectedArtifact.sha256 !== normalized.artifactSha256) fail('SOURCE_VERSION_MISMATCH', 'The protected artifact digest no longer matches this removal request.', 409);
  if (protectedArtifact.size < 64 || protectedArtifact.size > MAX_OUTPUT_BYTES) fail('PDFKIT_PROTECTION_REMOVAL_SOURCE_UNSUPPORTED', 'The retained protected artifact is outside the fixed size boundary.', 422);
  const { profile: sourceProfile, permissions, pageCount: protectedPageCount } = deriveProtectedArtifactProfile(protectedArtifact, document);
  const job = createJobSignal(externalSignal);
  let workspace = null;
  let requestBuffer = null;
  try {
    await store.verifySource(documentId);
    workspace = await store.createJobWorkspace(documentId);
    const inputPath = join(workspace, 'input.pdf');
    const outputPath = join(workspace, 'output.pdf');
    const inputIdentity = await stagePrivateSourceCopy({ sourcePath: protectedArtifact.filePath, targetPath: inputPath, expectedSha256: protectedArtifact.sha256, expectedSize: protectedArtifact.size, maximumBytes: MAX_OUTPUT_BYTES });
    await assertWorkspace(workspace, BEFORE_FILES);
    const sourceBytes = await readStableOutput(inputPath);
    let sourceEnvelope;
    try { sourceEnvelope = inspectAnySupportedPdfKitAes128Envelope(sourceBytes); } catch (error) {
      throw new HostError('PDFKIT_PROTECTION_REMOVAL_SOURCE_UNSUPPORTED', 'The retained artifact is not one of the fixed supported AES-128 envelopes.', 422, { cause: error });
    }
    if (sourceEnvelope.permissionsRaw !== permissions.pdfPermissionValue) fail('PDFKIT_PROTECTION_REMOVAL_SOURCE_UNSUPPORTED', 'The retained artifact permission envelope disagrees with its validated provenance.', 422);
    requestBuffer = serializeProtectionRemovalRequest(protectedArtifact.sha256, sourceProfile, normalized.ownerPassword);
    const result = await adapter.removeProtection({ workspacePath: workspace, requestBuffer }, { signal: job.signal, timeoutMs: 30_000 });
    requestBuffer.fill(0); requestBuffer = null;
    await assertWorkspace(workspace, AFTER_FILES);
    await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: protectedArtifact.sha256, expectedSize: protectedArtifact.size, maximumBytes: MAX_OUTPUT_BYTES });
    if (!protectionRemovalReceiptMatches(result, protectedArtifact, sourceProfile, protectedPageCount)) fail('PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID', 'The native protection-removal receipt did not match its protected artifact.', 502);
    const outputIdentity = await fileIdentity(outputPath);
    const outputBytes = await readStableOutput(outputPath);
    const outputDigest = await digestFile(outputPath);
    if (outputDigest !== result.outputSha256 || outputDigest === protectedArtifact.sha256) fail('PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID', 'The unencrypted output digest did not match the native receipt.', 502);
    try { inspectUnencryptedClassicPdfEnvelope(outputBytes); } catch (error) {
      throw new HostError('PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID', 'The derived copy retained or ambiguously represented an encryption reference.', 502, { cause: error });
    }
    const runOptions = { cwd: workspace, signal: job.signal, timeoutMs: 30_000, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 256 * 1024 };
    const inspection = parsePdfInfo((await poppler.execute('inspect', { input: outputPath }, runOptions)).stdout);
    if (String(inspection.encrypted).toLowerCase() !== 'no' || inspection.pageCount !== result.pageCount || String(inspection.form).toLowerCase() !== 'none' || String(inspection.javascript).toLowerCase() !== 'no' || String(inspection.tagged).toLowerCase() !== 'no') fail('PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID', 'Poppler disagreed with the fixed unencrypted output contract.', 502);
    const [attachments, urls] = await Promise.all([
      poppler.execute('listAttachments', { input: outputPath }, runOptions).then(({ stdout }) => parseAttachments(stdout)),
      poppler.execute('inspectUrls', { input: outputPath }, runOptions).then(({ stdout }) => parseDocumentUrls(stdout)),
    ]);
    if (attachments.length !== 0 || urls.length !== 0) fail('PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID', 'The unencrypted output contains unsupported attachments or external URLs.', 502);
    for (let page = 1; page <= result.pageCount; page += 1) {
      const outputPrefix = join(workspace, `validated-${page}`);
      await poppler.execute('renderPagePng', { input: outputPath, outputPrefix, page, maxDimension: 256 }, runOptions);
      const renderedPath = `${outputPrefix}.png`;
      await assertPng(renderedPath);
      await unlink(renderedPath);
    }
    await assertWorkspace(workspace, AFTER_FILES);
    await assertIdentity(outputPath, outputIdentity);
    if (await digestFile(outputPath) !== outputDigest) fail('PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID', 'The unencrypted PDF changed during independent validation.', 502);
    await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: protectedArtifact.sha256, expectedSize: protectedArtifact.size, maximumBytes: MAX_OUTPUT_BYTES });
    await store.verifySource(documentId);
    const provenance = createOperationProvenance({
      type: 'pdfkit-protection-removal', inputs: [{ documentId, sha256: document.sha256, role: 'source' }],
      parameters: { profile: PDFKIT_PROTECTION_REMOVAL_PROFILE, protectedArtifactSha256: protectedArtifact.sha256, sourceProtectionProfile: sourceProfile },
      expected: { pageCount: protectedPageCount, encrypted: false, sourceUnchanged: true, protectedArtifactRetained: true },
      validation: { passed: true, validators: ['protected-artifact-provenance', 'source-sha256', 'fixed-aes128-envelope', 'native-owner-authorization', 'native-private-snapshot-match', 'classic-xref-no-encrypt', 'poppler-unauthenticated-open', 'poppler-all-page-render', 'artifact-sha256'], pageCount: protectedPageCount, outputSha256: outputDigest },
    });
    const stem = basename(protectedArtifact.displayName, extname(protectedArtifact.displayName));
    const artifact = await promoteValidatedPdfArtifact({
      store, documentId, outputPath, displayName: `${stem}-unprotected.pdf`, operation: provenance, outputDigest,
      signal: job.signal, invalidCode: 'PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID', invalidMessage: 'The promoted unencrypted PDF does not match the validated output.',
    });
    return freezeResult({
      kind: 'pdfkit-protection-removal', sourceDigest: protectedArtifact.sha256, artifact,
      protection: { profile: PDFKIT_PROTECTION_REMOVAL_PROFILE, sourceProtectionProfile: sourceProfile, ownerAuthorizationVerified: true, encrypted: false },
      evidence: { protectedArtifactProvenanceVerified: true, sourceEnvelopeValidated: true, ownerAuthorizationVerified: true, nativeContentChecksPassed: true, finalTrailerUnencrypted: true, popplerUnauthenticatedOpenPassed: true, allPagesRendered: true, artifactDigestBound: true, encryptedSourceRetained: true },
      limitations: ['This removes protection only from a retained PDF created by the current local fixed AES-128 protection boundary.', 'The result is a separate cleartext PDF; the encrypted artifact and immutable original remain retained and unchanged.', 'This is not password recovery, arbitrary decryption, secure erasure, signature-safe rewriting, or byte/object preservation.'],
    });
  } catch (error) {
    if (job.timedOut) throw new HostError('PDFKIT_PROTECTION_REMOVAL_TIMEOUT', 'PDFKit protection removal exceeded its two-minute deadline.', 504, { cause: error });
    if (externalSignal?.aborted) throw new HostError('JOB_CANCELLED', 'PDFKit protection removal was cancelled.', 499, { cause: error });
    if (error instanceof HostError) throw error;
    if (error?.code === 'INVALID_REQUEST') throw new HostError('INVALID_PDFKIT_PROTECTION_REMOVAL_OPTIONS', 'The pinned helper rejected the fixed protection-removal request.', 400);
    if (error?.code === 'MUTATION_FAILED') throw new HostError('PDFKIT_PROTECTION_REMOVAL_REJECTED', 'The owner credential or protected artifact is outside the fixed protection-removal boundary.', 422);
    if (error?.code === 'OUTPUT_INVALID') throw new HostError('PDFKIT_PROTECTION_REMOVAL_OUTPUT_INVALID', 'The pinned helper could not prove the unencrypted derived copy.', 502, { cause: error });
    throw new HostError('PDFKIT_PROTECTION_REMOVAL_FAILED', 'The pinned local PDFKit helper could not create a verified unencrypted copy.', 502, { cause: error });
  } finally {
    requestBuffer?.fill(0); job.dispose(); if (workspace) await store.cleanupJob(workspace);
  }
}
