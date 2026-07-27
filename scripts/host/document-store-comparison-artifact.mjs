import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { validateOperationProvenance } from './operation-provenance.mjs';
import { cleanDisplayName, freezeRecord, insideStore, SHA256 } from './document-store-contract.mjs';
import { getDocument, verifySource } from './document-store-documents.mjs';
import { copyVerifiedFileHandle, throwIfPromotionAborted } from './document-store-file-io.mjs';
import { validateComparisonPackage } from './comparison-package-contract.mjs';
import { COMPARISON_PACKAGE_EXTENSION, COMPARISON_PACKAGE_MAX_BYTES, COMPARISON_PACKAGE_MEDIA_TYPE } from './comparison-package-types.mjs';

export { COMPARISON_PACKAGE_EXTENSION, COMPARISON_PACKAGE_MAX_BYTES, COMPARISON_PACKAGE_MEDIA_TYPE };

function invalid(message, status = 502, cause) {
  throw new HostError('INVALID_COMPARISON_PACKAGE_ARTIFACT', message, status, cause ? { cause } : undefined);
}

function validateInputs(provenance, primary, revision) {
  if (provenance.type !== 'comparison-package' || provenance.inputs.length !== 2) invalid('Comparison package provenance must bind exactly two source documents.', 500);
  const [left, right] = provenance.inputs;
  if (left.role !== 'primary' || left.documentId !== primary.id || left.sha256 !== primary.sha256
    || right.role !== 'revision' || right.documentId !== revision.id || right.sha256 !== revision.sha256) {
    invalid('Comparison package provenance does not exactly bind the primary and revision sources.', 500);
  }
}

export async function promoteComparisonPackageArtifact(state, primaryDocumentId, revisionDocumentId, sourcePath, {
  displayName = `comparison.${COMPARISON_PACKAGE_EXTENSION}`, mediaType, extension,
  operation, expectedSha256, signal,
} = {}) {
  if (primaryDocumentId === revisionDocumentId) invalid('Comparison package sources must be distinct.', 400);
  if (mediaType !== COMPARISON_PACKAGE_MEDIA_TYPE || extension !== COMPARISON_PACKAGE_EXTENSION) invalid('Comparison package promotion requires the exact extension and media type.', 400);
  if (!SHA256.test(String(expectedSha256 ?? ''))) throw new HostError('INVALID_EXPECTED_ARTIFACT_DIGEST', 'Comparison package promotion requires the validated output SHA-256 digest.', 500);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
  throwIfPromotionAborted(signal);
  await Promise.all([verifySource(state, primaryDocumentId), verifySource(state, revisionDocumentId)]);
  const primary = getDocument(state, primaryDocumentId); const revision = getDocument(state, revisionDocumentId);
  const provenance = validateOperationProvenance(operation); validateInputs(provenance, primary, revision);
  let source;
  try {
    const pathStat = await lstat(sourcePath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1 || pathStat.size < 1
      || pathStat.size > COMPARISON_PACKAGE_MAX_BYTES || pathStat.size > state.maxBytes) invalid('Comparison package output must be a bounded single-link regular file.');
    const handle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || stat.size !== pathStat.size) {
      await handle.close(); invalid('Comparison package output changed before retention.');
    }
    source = { handle, stat };
    const packageBytes = Buffer.alloc(stat.size);
    try {
      const { bytesRead } = await handle.read(packageBytes, 0, packageBytes.length, 0);
      if (bytesRead !== packageBytes.length) invalid('Comparison package output changed during package validation.');
      validateComparisonPackage(packageBytes, primary.sha256, revision.sha256);
    } finally { packageBytes.fill(0); }
  } catch (error) {
    await source?.handle?.close().catch(() => {});
    if (error instanceof HostError) throw error;
    invalid('Comparison package output could not be opened safely.', 502, error);
  }
  const id = randomUUID(); const directory = insideStore(state, 'artifacts', id);
  const partialPath = join(directory, 'artifact.partial'); const finalPath = join(directory, `artifact.${COMPARISON_PACKAGE_EXTENSION}`);
  let partialHandle;
  try {
    await mkdir(directory, { mode: 0o700 }); partialHandle = await open(partialPath, 'wx', 0o600);
    const digest = await copyVerifiedFileHandle(source.handle, partialHandle, source.stat.size, signal);
    if (digest !== expectedSha256) throw new HostError('ARTIFACT_DIGEST_MISMATCH', 'Comparison package bytes no longer match the validated digest.', 502);
    const finalSourceStat = await source.handle.stat();
    if (finalSourceStat.size !== source.stat.size || finalSourceStat.mtimeMs !== source.stat.mtimeMs || finalSourceStat.ctimeMs !== source.stat.ctimeMs) invalid('Comparison package output changed during retention.');
    await Promise.all([verifySource(state, primary.id), verifySource(state, revision.id)]);
    await partialHandle.sync(); throwIfPromotionAborted(signal); await partialHandle.close(); partialHandle = null;
    await chmod(partialPath, 0o600); throwIfPromotionAborted(signal); await rename(partialPath, finalPath); throwIfPromotionAborted(signal);
    const artifact = { id, documentId: primary.id, displayName: cleanDisplayName(displayName, `comparison.${COMPARISON_PACKAGE_EXTENSION}`), mediaType, size: source.stat.size, sha256: expectedSha256, operation: provenance, createdAt: new Date().toISOString() };
    state.artifacts.set(id, { ...artifact, filePath: finalPath, directory }); return freezeRecord(artifact);
  } catch (error) {
    await partialHandle?.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); throw error;
  } finally {
    await source.handle.close().catch(() => {});
  }
}
