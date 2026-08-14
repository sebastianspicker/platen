import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { buildPdfHiddenDataSanitization, inspectPdfHiddenDataSanitization, PDF_HIDDEN_DATA_SANITIZER_PROFILE, MAX_PDF_HIDDEN_DATA_SANITIZER_OUTPUT_BYTES, MAX_PDF_HIDDEN_DATA_SANITIZER_SOURCE_BYTES } from './pdf-hidden-data-sanitizer.mjs';

export const MAX_PDF_HIDDEN_DATA_SANITIZATION_JOB_MS = 120_000;
export const HIDDEN_DATA_SANITIZATION_BEFORE_FILES = Object.freeze([]);
export const HIDDEN_DATA_SANITIZATION_AFTER_FILES = Object.freeze(['output.pdf', 'source.pdf']);
const PRIVATE_SOURCE_MODE = 0o400;
const PRIVATE_OUTPUT_MODE = 0o600;

function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameIdentity(left, right) { return ['dev', 'ino', 'nlink', 'size', 'mode', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]); }

function throwIfAborted(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'Hidden-data sanitization was cancelled.', 499, signal.reason); }

async function assertWorkspace(directory, expectedFiles) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) fail('HIDDEN_DATA_SANITIZATION_WORKSPACE_INVALID', 'The hidden-data sanitizer workspace is not private.', 502);
  const files = (await readdir(directory)).sort(); const expected = [...expectedFiles].sort();
  if (files.length !== expected.length || files.some((entry, index) => entry !== expected[index])) fail('HIDDEN_DATA_SANITIZATION_WORKSPACE_INVALID', 'The hidden-data sanitizer workspace contains unexpected files.', 502);
}

async function readPrivate(path, expectedSize, expectedMode, maximumBytes) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximumBytes) fail('HIDDEN_DATA_SANITIZATION_INPUT_TOO_LARGE', 'The hidden-data sanitizer input exceeds its fixed bound.', 413);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(expectedSize) || (before.mode & 0o777n) !== BigInt(expectedMode)) fail('HIDDEN_DATA_SANITIZATION_TAMPERED', 'A private hidden-data sanitizer file has unsafe metadata.', 502);
    const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true });
    if (bytes.length !== expectedSize || !sameIdentity(before, after)) fail('HIDDEN_DATA_SANITIZATION_TAMPERED', 'A private hidden-data sanitizer file changed during verification.', 502);
    return Object.freeze({ bytes, identity: before });
  } finally { await handle.close(); }
}

async function writePrivate(path, bytes) {
  const handle = await open(path, 'wx', PRIVATE_OUTPUT_MODE);
  try { let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset, offset); if (result.bytesWritten < 1) throw new Error('short write'); offset += result.bytesWritten; } await handle.sync(); await handle.chmod(PRIVATE_OUTPUT_MODE); }
  finally { await handle.close(); }
  await readPrivate(path, bytes.length, PRIVATE_OUTPUT_MODE, MAX_PDF_HIDDEN_DATA_SANITIZER_OUTPUT_BYTES);
}

export async function runHiddenDataSanitizationJob({ store, documentId, source, request, deadline, lifecycle }) {
  throwIfAborted(deadline.signal); await store.verifySource(documentId);
  const workspace = await store.createJobWorkspace(documentId); lifecycle.workspace = workspace;
  await assertWorkspace(workspace, HIDDEN_DATA_SANITIZATION_BEFORE_FILES);
  const sourcePath = join(workspace, 'source.pdf');
  const sourceIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: sourcePath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_HIDDEN_DATA_SANITIZER_SOURCE_BYTES, signal: deadline.signal });
  await assertWorkspace(workspace, ['source.pdf']);
  const sourceRead = await readPrivate(sourcePath, source.size, PRIVATE_SOURCE_MODE, MAX_PDF_HIDDEN_DATA_SANITIZER_SOURCE_BYTES);
  await assertPrivateSourceCopy({ path: sourcePath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_HIDDEN_DATA_SANITIZER_SOURCE_BYTES });
  throwIfAborted(deadline.signal);
  let built; try { built = buildPdfHiddenDataSanitization(sourceRead.bytes, request); } catch (error) { throw error; }
  if (!built?.proof || !Buffer.isBuffer(built.bytes) || built.bytes.length > MAX_PDF_HIDDEN_DATA_SANITIZER_OUTPUT_BYTES) fail('HIDDEN_DATA_SANITIZATION_OUTPUT_INVALID', 'The hidden-data sanitizer core returned an invalid bounded output.', 502);
  const outputPath = join(workspace, 'output.pdf'); await writePrivate(outputPath, built.bytes);
  await assertWorkspace(workspace, HIDDEN_DATA_SANITIZATION_AFTER_FILES);
  const outputRead = await readPrivate(outputPath, built.bytes.length, PRIVATE_OUTPUT_MODE, MAX_PDF_HIDDEN_DATA_SANITIZER_OUTPUT_BYTES);
  if (!outputRead.bytes.equals(built.bytes)) fail('HIDDEN_DATA_SANITIZATION_TAMPERED', 'The hidden-data sanitizer output changed before inspection.', 502);
  let inspected; try { inspected = inspectPdfHiddenDataSanitization(sourceRead.bytes, outputRead.bytes, request); } catch (error) { fail('HIDDEN_DATA_SANITIZATION_OUTPUT_INVALID', 'Independent hidden-data residue inspection rejected the output.', 502, error); }
  if (JSON.stringify(inspected) !== JSON.stringify(built.proof)) fail('HIDDEN_DATA_SANITIZATION_OUTPUT_INVALID', 'Independent hidden-data inspection disagreed with the sanitizer proof.', 502);
  const sourceAgain = await readPrivate(sourcePath, source.size, PRIVATE_SOURCE_MODE, MAX_PDF_HIDDEN_DATA_SANITIZER_SOURCE_BYTES);
  if (!sourceAgain.bytes.equals(sourceRead.bytes)) fail('HIDDEN_DATA_SANITIZATION_SOURCE_TAMPERED', 'The staged immutable source changed during sanitization.', 500);
  await assertPrivateSourceCopy({ path: sourcePath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_HIDDEN_DATA_SANITIZER_SOURCE_BYTES });
  await store.verifySource(documentId); throwIfAborted(deadline.signal);
  const outputSha256 = digest(outputRead.bytes);
  const provenance = createOperationProvenance({
    type: 'pdf-hidden-data-sanitization',
    inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: { profile: PDF_HIDDEN_DATA_SANITIZER_PROFILE },
    expected: { outputSha256, sourcePrefixPreserved: false, reachablePageContentPreserved: true, secureErasure: false, signaturePreservation: false },
    validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'bounded-sanitizer-core', 'independent-residue-inventory', 'page-content-stream-digest', 'output-sha256'], outputSha256 },
  });
  lifecycle.promotedArtifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: 'hidden-data-sanitized.pdf', operation: provenance, expectedSha256: outputSha256, signal: deadline.signal });
  if (lifecycle.promotedArtifact.sha256 !== outputSha256 || lifecycle.promotedArtifact.id === source.id) fail('HIDDEN_DATA_SANITIZATION_OUTPUT_INVALID', 'The promoted sanitized artifact does not match the independently inspected output.', 502);
  lifecycle.completed = true;
  return Object.freeze({ artifact: lifecycle.promotedArtifact, proof: inspected, limitations: inspected.limitations });
}

export async function cleanupHiddenDataSanitizationJob({ store, lifecycle }) {
  let workspaceError = null; let artifactError = null;
  if (lifecycle.workspace) { try { await store.cleanupJob(lifecycle.workspace); } catch (error) { workspaceError = error; } }
  if ((!lifecycle.completed || workspaceError) && lifecycle.promotedArtifact?.id) {
    try { await store.deleteArtifact(lifecycle.promotedArtifact.id); } catch (error) { artifactError = error; }
  }
  if (workspaceError || artifactError) fail('HIDDEN_DATA_SANITIZATION_CLEANUP_FAILED', 'Hidden-data sanitization could not clean its private workspace and artifact state.', 500, workspaceError ?? artifactError);
}
