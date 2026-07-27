import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { validateOperationProvenance } from './operation-provenance.mjs';
import { assertOpaqueId, cleanDisplayName, containsPdfHeader, freezeRecord, insideStore, SHA256 } from './document-store-contract.mjs';
import { getDocument, verifySource } from './document-store-documents.mjs';
import { copyVerifiedFileHandle, throwIfPromotionAborted } from './document-store-file-io.mjs';

const OOXML_ARTIFACTS = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});
const OOXML_MAX_BYTES = 64 * 1024 * 1024;

export async function promotePdfArtifact(state, documentId, sourcePath, { displayName = 'derived-document.pdf', operation, expectedSha256, signal }) {
  if (!SHA256.test(String(expectedSha256 ?? ''))) throw new HostError('INVALID_EXPECTED_ARTIFACT_DIGEST', 'Artifact promotion requires the validated output SHA-256 digest.', 500);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
  throwIfPromotionAborted(signal);
  await verifySource(state, documentId);
  const owningSource = getDocument(state, documentId);
  const provenance = validateOperationProvenance(operation);
  const owningInputs = provenance.inputs.filter((input) => input.documentId === documentId);
  if (owningInputs.length === 0 || owningInputs.some((input) => input.sha256 !== owningSource.sha256)) {
    throw new HostError('INVALID_OPERATION_PROVENANCE', 'Artifact provenance must include the owning source document and its current digest.', 500);
  }
  const source = await openSafeEngineOutput(sourcePath);
  try {
    validateEngineOutput(state, source.handle, source.stat);
    await validatePdfHeader(source.handle, source.stat);
    return await retainArtifact(state, documentId, source.handle, source.stat, { displayName, provenance, expectedSha256, signal });
  } finally {
    await source.handle.close().catch(() => {});
  }
}

/** Promote only the deterministic text-only OOXML artifacts emitted by the local export service. */
export async function promoteOoxmlArtifact(state, documentId, sourcePath, {
  displayName, mediaType, extension, operation, expectedSha256, signal,
}) {
  if (!Object.hasOwn(OOXML_ARTIFACTS, extension) || OOXML_ARTIFACTS[extension] !== mediaType) {
    throw new HostError('INVALID_OOXML_ARTIFACT', 'OOXML artifact promotion requires an exact supported extension and media type.', 400);
  }
  if (!SHA256.test(String(expectedSha256 ?? ''))) throw new HostError('INVALID_EXPECTED_ARTIFACT_DIGEST', 'Artifact promotion requires the validated output SHA-256 digest.', 500);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
  throwIfPromotionAborted(signal);
  await verifySource(state, documentId);
  const owningSource = getDocument(state, documentId);
  const provenance = validateOperationProvenance(operation);
  const owningInputs = provenance.inputs.filter((input) => input.documentId === documentId);
  if (owningInputs.length === 0 || owningInputs.some((input) => input.sha256 !== owningSource.sha256)) {
    throw new HostError('INVALID_OPERATION_PROVENANCE', 'Artifact provenance must include the owning source document and its current digest.', 500);
  }
  let source;
  try {
    const pathStat = await lstat(sourcePath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1 || pathStat.size === 0 || pathStat.size > OOXML_MAX_BYTES || pathStat.size > state.maxBytes) {
      throw new HostError('INVALID_OOXML_ARTIFACT', 'The OOXML export did not produce a bounded single-link regular file.', 502);
    }
    const handle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || stat.size !== pathStat.size) {
      await handle.close();
      throw new HostError('INVALID_OOXML_ARTIFACT', 'The OOXML export changed before it could be retained.', 502);
    }
    source = { handle, stat };
  } catch (error) {
    await source?.handle?.close().catch(() => {});
    if (error instanceof HostError) throw error;
    throw new HostError('INVALID_OOXML_ARTIFACT', 'The OOXML export did not produce a safe output file.', 502, { cause: error });
  }
  const id = randomUUID();
  const directory = insideStore(state, 'artifacts', id);
  const partialPath = join(directory, 'artifact.partial');
  const finalPath = join(directory, `artifact.${extension}`);
  let partialHandle;
  try {
    await mkdir(directory, { mode: 0o700 });
    partialHandle = await open(partialPath, 'wx', 0o600);
    const digest = await copyVerifiedFileHandle(source.handle, partialHandle, source.stat.size, signal);
    if (digest !== expectedSha256) throw new HostError('ARTIFACT_DIGEST_MISMATCH', 'The OOXML output no longer matches the validated artifact digest.', 502);
    const finalSourceStat = await source.handle.stat();
    if (finalSourceStat.size !== source.stat.size || finalSourceStat.mtimeMs !== source.stat.mtimeMs || finalSourceStat.ctimeMs !== source.stat.ctimeMs) throw new HostError('INVALID_OOXML_ARTIFACT', 'The OOXML output changed while it was being retained.', 502);
    await partialHandle.sync();
    throwIfPromotionAborted(signal);
    await partialHandle.close(); partialHandle = null;
    await chmod(partialPath, 0o600);
    throwIfPromotionAborted(signal);
    await rename(partialPath, finalPath);
    throwIfPromotionAborted(signal);
    const artifact = { id, documentId, displayName: cleanDisplayName(displayName, `derived-document.${extension}`), mediaType, size: source.stat.size, sha256: expectedSha256, operation: provenance, createdAt: new Date().toISOString() };
    state.artifacts.set(id, { ...artifact, filePath: finalPath, directory });
    return freezeRecord(artifact);
  } catch (error) {
    await partialHandle?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await source.handle.close().catch(() => {});
  }
}

async function openSafeEngineOutput(sourcePath) {
  let handle;
  try {
    const pathStat = await lstat(sourcePath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1) throw new HostError('INVALID_ENGINE_OUTPUT', 'The PDF engine did not produce a single-link regular file.', 502);
    handle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) throw new HostError('INVALID_ENGINE_OUTPUT', 'The PDF engine output changed before it could be retained.', 502);
    return { handle, stat };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof HostError) throw error;
    throw new HostError('INVALID_ENGINE_OUTPUT', 'The PDF engine did not produce a safe output file.', 502, { cause: error });
  }
}

function validateEngineOutput(state, handle, stat) {
  if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > state.maxBytes) {
    void handle.close().catch(() => {});
    throw new HostError('INVALID_ENGINE_OUTPUT', 'The PDF engine did not produce a bounded single-link regular file.', 502);
  }
}

async function validatePdfHeader(handle, stat) {
  const prefix = Buffer.alloc(Math.min(1024, stat.size));
  let prefixBytes;
  try {
    ({ bytesRead: prefixBytes } = await handle.read(prefix, 0, prefix.length, 0));
  } catch (error) {
    await handle.close().catch(() => {});
    throw new HostError('INVALID_ENGINE_OUTPUT', 'The PDF engine output could not be read safely.', 502, { cause: error });
  }
  if (prefixBytes !== prefix.length) {
    await handle.close().catch(() => {});
    throw new HostError('INVALID_ENGINE_OUTPUT', 'The PDF engine output changed during validation.', 502);
  }
  if (!containsPdfHeader(prefix)) {
    await handle.close().catch(() => {});
    throw new HostError('INVALID_ENGINE_OUTPUT', 'The PDF engine output is not a PDF document.', 502);
  }
}

async function retainArtifact(state, documentId, sourceHandle, sourceStat, { displayName, provenance, expectedSha256, signal }) {
  const id = randomUUID();
  const directory = insideStore(state, 'artifacts', id);
  const partialPath = join(directory, 'artifact.partial');
  const finalPath = join(directory, 'artifact.pdf');
  let artifactDigest;
  let partialHandle;
  try {
    await mkdir(directory, { mode: 0o700 });
    partialHandle = await open(partialPath, 'wx', 0o600);
    artifactDigest = await copyVerifiedFileHandle(sourceHandle, partialHandle, sourceStat.size, signal);
    if (artifactDigest !== expectedSha256) throw new HostError('ARTIFACT_DIGEST_MISMATCH', 'The PDF engine output no longer matches the validated artifact digest.', 502);
    const finalSourceStat = await sourceHandle.stat();
    if (finalSourceStat.size !== sourceStat.size || finalSourceStat.mtimeMs !== sourceStat.mtimeMs || finalSourceStat.ctimeMs !== sourceStat.ctimeMs) throw new HostError('INVALID_ENGINE_OUTPUT', 'The PDF engine output changed while it was being retained.', 502);
    await partialHandle.sync();
    throwIfPromotionAborted(signal);
    await partialHandle.close();
    partialHandle = null;
    await chmod(partialPath, 0o600);
    throwIfPromotionAborted(signal);
    await rename(partialPath, finalPath);
    throwIfPromotionAborted(signal);
  } catch (error) {
    await partialHandle?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const artifact = { id, documentId, displayName: cleanDisplayName(displayName, 'derived-document.pdf'), mediaType: 'application/pdf', size: sourceStat.size, sha256: artifactDigest, operation: provenance, createdAt: new Date().toISOString() };
  state.artifacts.set(id, { ...artifact, filePath: finalPath, directory });
  return freezeRecord(artifact);
}

export function getArtifact(state, id) {
  assertOpaqueId(id);
  const artifact = state.artifacts.get(id);
  if (!artifact) throw new HostError('ARTIFACT_NOT_FOUND', 'The derived PDF artifact was not found.', 404);
  return freezeRecord(publicArtifact(artifact));
}

export function claimArtifactForTransfer(state, id) {
  assertOpaqueId(id);
  const artifact = state.artifacts.get(id);
  if (!artifact) throw new HostError('ARTIFACT_NOT_FOUND', 'The derived PDF artifact was not found.', 404);
  state.artifacts.delete(id);
  let cleanupPromise = null;
  return Object.freeze({ artifact: freezeRecord(publicArtifact(artifact)), cleanup: () => {
    cleanupPromise ??= rm(artifact.directory, { recursive: true, force: true });
    return cleanupPromise;
  } });
}

export async function deleteArtifact(state, id) {
  assertOpaqueId(id);
  const artifact = state.artifacts.get(id);
  if (!artifact) throw new HostError('ARTIFACT_NOT_FOUND', 'The derived PDF artifact was not found.', 404);
  state.artifacts.delete(id);
  await rm(artifact.directory, { recursive: true, force: true });
}

export async function deleteDocument(state, id) {
  const record = state.documents.get(id);
  getDocument(state, id);
  state.documents.delete(id);
  await rm(record.directory, { recursive: true, force: true });
  for (const [artifactId, artifact] of state.artifacts) {
    if (artifact.documentId !== id) continue;
    state.artifacts.delete(artifactId);
    await rm(artifact.directory, { recursive: true, force: true });
  }
}

function publicArtifact(artifact) {
  return { id: artifact.id, documentId: artifact.documentId, displayName: artifact.displayName, mediaType: artifact.mediaType, size: artifact.size, sha256: artifact.sha256, operation: artifact.operation, createdAt: artifact.createdAt, filePath: artifact.filePath };
}
