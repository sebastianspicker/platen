import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { digestFile } from './document-store.mjs';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { inspectPdfKitAes128Envelope } from './pdf-encryption-envelope.mjs';
import {
  normalizeProtectionRequest, PDFKIT_PROTECTION_LIMITS, PDFKIT_PROTECTION_PROFILE,
  protectionReceiptMatches, serializeProtectionRequest,
} from './pdfkit-protection-contract.mjs';
import {
  AFTER_FILES, BEFORE_FILES, MAX_SOURCE_BYTES, SHA256, assertIdentity, assertWorkspace,
  createJobSignal, fail, fileIdentity, freezeResult, promoteValidatedPdfArtifact, readStableOutput,
} from './pdfkit-protection-pipeline.mjs';

const POPPLER_PASSWORD_ERROR = 'Command Line Error: Incorrect password\n';

async function assertPopplerRequiresPassword(poppler, outputPath, workspace, signal) {
  let rejection = null;
  try {
    await poppler.execute('inspect', { input: outputPath }, {
      cwd: workspace, signal, timeoutMs: 30_000,
      maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024,
    });
  } catch (error) {
    rejection = error;
  }
  if (!rejection || rejection.exitCode !== 1 || rejection.stdout !== ''
    || rejection.stderr !== POPPLER_PASSWORD_ERROR) {
    fail('PDFKIT_PASSWORD_VALIDATION_FAILED', 'The protected PDF did not enforce the expected unauthenticated-open boundary.', 502);
  }
}

export async function protectPdfKitDocument({ store, pdfService, poppler, adapter }, documentId, protectionInput, { sourceSha256, signal: externalSignal } = {}) {
  const source = store.getDocument(documentId);
  if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256) {
    fail('SOURCE_VERSION_MISMATCH', 'The protection source digest does not match the current document.', 409);
  }
  const normalized = normalizeProtectionRequest(protectionInput);
  if (source.size < 1 || source.size > MAX_SOURCE_BYTES) {
    fail('PDFKIT_INPUT_TOO_LARGE', 'PDFKit protection is limited to non-empty 128 MiB source documents.', 413);
  }
  const job = createJobSignal(externalSignal);
  let workspace = null;
  let requestBuffer = null;
  try {
    await store.verifySource(documentId);
    const inspection = await pdfService.inspect(documentId, { signal: job.signal });
    if (inspection.pageCount > PDFKIT_PROTECTION_LIMITS.maxPages) {
      fail('PDFKIT_PAGE_LIMIT', `PDFKit protection is limited to ${PDFKIT_PROTECTION_LIMITS.maxPages} pages.`, 422);
    }
    if (String(inspection.encrypted).toLowerCase() !== 'no'
      || String(inspection.form).toLowerCase() !== 'none'
      || String(inspection.javascript).toLowerCase() !== 'no'
      || String(inspection.tagged).toLowerCase() !== 'no') {
      fail('PDFKIT_PROTECTION_SOURCE_UNSUPPORTED', 'Fixed AES-128 protection requires an unencrypted, untagged PDF without forms or JavaScript.', 422);
    }
    const signatures = await pdfService.verifySignatures(documentId, { signal: job.signal });
    if (signatures.status !== 'unsigned' || signatures.signatureCount !== 0 || signatures.sourceSha256 !== source.sha256) {
      fail('PDFKIT_SIGNED_SOURCE_UNSUPPORTED', 'Password protection rejects signed or indeterminate-signature PDFs.', 422);
    }
    const attachments = await pdfService.listAttachments(documentId, { signal: job.signal });
    if (!Array.isArray(attachments) || attachments.length !== 0) {
      fail('PDFKIT_PROTECTION_SOURCE_UNSUPPORTED', 'Fixed AES-128 protection rejects PDFs with embedded attachments.', 422);
    }
    const structure = await pdfService.inspectStructure(documentId, {
      firstPage: 1, lastPage: inspection.pageCount, includeTagText: false, signal: job.signal,
    });
    if (structure.sourceDigest !== source.sha256 || structure.pageRange.truncated
      || !Array.isArray(structure.urls) || structure.urls.length !== 0) {
      fail('PDFKIT_PROTECTION_SOURCE_UNSUPPORTED', 'Fixed AES-128 protection rejects active or externally linked PDF objects.', 422);
    }
    workspace = await store.createJobWorkspace(documentId);
    const inputPath = join(workspace, 'input.pdf');
    const outputPath = join(workspace, 'output.pdf');
    await copyFile(store.getSourcePath(documentId), inputPath, fsConstants.COPYFILE_EXCL);
    await chmod(inputPath, 0o400);
    if (await digestFile(inputPath) !== source.sha256) fail('SOURCE_INTEGRITY_FAILED', 'The private PDFKit source copy does not match the immutable document.', 500);
    const inputIdentity = await fileIdentity(inputPath);
    await assertWorkspace(workspace, BEFORE_FILES);
    requestBuffer = serializeProtectionRequest(source.sha256, normalized);
    const result = await adapter.protect({ workspacePath: workspace, requestBuffer }, { signal: job.signal, timeoutMs: 30_000 });
    requestBuffer.fill(0); requestBuffer = null;
    await assertWorkspace(workspace, AFTER_FILES);
    await assertIdentity(inputPath, inputIdentity);
    if (await digestFile(inputPath) !== source.sha256) fail('PDFKIT_WORKSPACE_INVALID', 'The PDFKit helper changed its immutable input.', 502);
    if (!protectionReceiptMatches(result, source, normalized) || result.pageCount !== inspection.pageCount) fail('PDFKIT_OUTPUT_INVALID', 'The PDFKit protection receipt did not match the fixed request.', 502);
    const outputIdentity = await fileIdentity(outputPath);
    const outputBytes = await readStableOutput(outputPath);
    const outputDigest = await digestFile(outputPath);
    if (outputDigest !== result.outputSha256 || outputDigest === source.sha256) fail('PDFKIT_OUTPUT_INVALID', 'The protected PDF digest did not match the native receipt.', 502);
    let encryption;
    try { encryption = inspectPdfKitAes128Envelope(outputBytes, { expectedPermissions: normalized.permissions.pdfPermissionValue }); } catch (error) {
      throw new HostError('PDFKIT_ENCRYPTION_INVALID', 'The protected PDF does not use the fixed AES-128 security envelope.', 502, { cause: error });
    }
    await assertPopplerRequiresPassword(poppler, outputPath, workspace, job.signal);
    await assertIdentity(outputPath, outputIdentity);
    if (await digestFile(outputPath) !== outputDigest) fail('PDFKIT_OUTPUT_INVALID', 'The protected PDF changed during independent validation.', 502);
    await assertIdentity(inputPath, inputIdentity);
    if (await digestFile(inputPath) !== source.sha256) fail('PDFKIT_WORKSPACE_INVALID', 'The PDFKit helper input changed during validation.', 502);
    await store.verifySource(documentId);
    const provenance = createOperationProvenance({
      type: 'pdfkit-password-protection', inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
      parameters: { profile: PDFKIT_PROTECTION_PROFILE, permissionsProfile: normalized.permissionsProfile },
      expected: { pageCount: inspection.pageCount, cipher: 'aes-128-cbc', sourceUnchanged: true },
      validation: { passed: true, validators: ['source-sha256', 'pinned-helper-sha256', 'native-password-reopen', 'native-structure-match', 'classic-xref-encryption-dictionary', 'poppler-unauthenticated-open-rejected', 'artifact-sha256'], pageCount: inspection.pageCount, outputSha256: outputDigest, permissionMask: result.effectivePermissionMask },
    });
    const stem = basename(source.displayName, extname(source.displayName));
    const artifact = await promoteValidatedPdfArtifact({
      store, documentId, outputPath, displayName: `${stem}-protected.pdf`, operation: provenance, outputDigest,
      signal: job.signal, invalidCode: 'PDFKIT_OUTPUT_INVALID', invalidMessage: 'The promoted protected PDF does not match the validated output.',
    });
    return freezeResult({
      kind: 'pdfkit-password-protection', sourceDigest: source.sha256, artifact,
      protection: { profile: PDFKIT_PROTECTION_PROFILE, handler: 'standard', revision: encryption.revision, cipher: 'AES-128-CBC', keyBits: encryption.keyLengthBits, metadataEncrypted: encryption.encryptMetadata, permissionsProfile: normalized.permissionsProfile, effectivePermissions: result.effectivePermissions },
      evidence: { helperBinaryDigestVerified: true, sourceDigestReverified: true, nativeCredentialChecksPassed: true, nativeContentChecksPassed: true, encryptionDictionaryValidated: true, popplerRejectedUnauthenticatedOpen: true, artifactDigestBound: true, sourceUnchanged: true },
      limitations: ['PDF permissions are advisory after opening and can be ignored by non-conforming readers.', 'This fixed profile uses AES-128 and four closed permission presets; it does not provide selectable AES strength or arbitrary combinations.', 'PDFKit rewrites the file; this is not byte preservation, incremental save, protection recovery, or signature-safe encryption.'],
    });
  } catch (error) {
    if (job.timedOut) throw new HostError('PDFKIT_PROTECTION_TIMEOUT', 'PDFKit password protection exceeded its two-minute deadline.', 504, { cause: error });
    if (externalSignal?.aborted) throw new HostError('JOB_CANCELLED', 'PDFKit password protection was cancelled.', 499, { cause: error });
    if (error instanceof HostError) throw error;
    // Do not retain native request errors: helper diagnostics may echo the
    // serialized credential fields, and credentials never belong in results,
    // logs, or error causes.
    if (error?.code === 'INVALID_REQUEST') throw new HostError('INVALID_PDFKIT_PROTECTION_OPTIONS', 'The pinned helper rejected the fixed protection request.', 400);
    if (error?.code === 'MUTATION_FAILED') throw new HostError('PDFKIT_PROTECTION_SOURCE_UNSUPPORTED', 'The pinned helper rejected unsupported source structure.', 422, { cause: error });
    throw new HostError('PDFKIT_PROTECTION_FAILED', 'The pinned local PDFKit helper could not create and validate password protection.', 502, { cause: error });
  } finally {
    requestBuffer?.fill(0); job.dispose(); if (workspace) await store.cleanupJob(workspace);
  }
}
