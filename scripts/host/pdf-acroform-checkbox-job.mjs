import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import {
  inspectPdfAcroFormCheckbox,
  PDF_ACROFORM_CHECKBOX_PROFILE,
  preparePdfAcroFormCheckbox,
} from './pdf-acroform-checkbox-writer.mjs';

export const MAX_PDF_ACROFORM_CHECKBOX_JOB_MS = 120_000;
export const MAX_PDF_ACROFORM_CHECKBOX_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_ACROFORM_CHECKBOX_OUTPUT_BYTES = MAX_PDF_ACROFORM_CHECKBOX_SOURCE_BYTES + 512 * 1024;
export const ACROFORM_CHECKBOX_BEFORE_FILES = Object.freeze([]);
export const ACROFORM_CHECKBOX_AFTER_FILES = Object.freeze(['output.pdf', 'source.pdf']);
const PRIVATE_SOURCE_MODE = 0o400;
const PRIVATE_OUTPUT_MODE = 0o600;

function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameIdentity(left, right) { return ['dev', 'ino', 'nlink', 'size', 'mode', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]); }
function throwIfAborted(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'AcroForm checkbox processing was cancelled.', 499, signal.reason); }

async function assertWorkspace(directory, expectedFiles) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) fail('ACROFORM_CHECKBOX_WORKSPACE_INVALID', 'The AcroForm checkbox workspace is not private.', 502);
  const files = (await readdir(directory)).sort(); const expected = [...expectedFiles].sort();
  if (files.length !== expected.length || files.some((entry, index) => entry !== expected[index])) fail('ACROFORM_CHECKBOX_WORKSPACE_INVALID', 'The AcroForm checkbox workspace contains unexpected files.', 502);
}

async function readPrivate(path, expectedSize, expectedMode, maximumBytes) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximumBytes) fail('ACROFORM_CHECKBOX_INPUT_TOO_LARGE', 'The AcroForm checkbox file exceeds its fixed bound.', 413);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(expectedSize) || (before.mode & 0o777n) !== BigInt(expectedMode)) fail('ACROFORM_CHECKBOX_TAMPERED', 'A private AcroForm checkbox file has unsafe metadata.', 502);
    const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true });
    if (bytes.length !== expectedSize || !sameIdentity(before, after)) fail('ACROFORM_CHECKBOX_TAMPERED', 'A private AcroForm checkbox file changed during verification.', 502);
    return Object.freeze({ bytes, identity: before });
  } finally { await handle.close(); }
}

async function writePrivate(path, bytes) {
  const handle = await open(path, 'wx', PRIVATE_OUTPUT_MODE);
  try { let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset, offset); if (result.bytesWritten < 1) throw new Error('short write'); offset += result.bytesWritten; } await handle.sync(); await handle.chmod(PRIVATE_OUTPUT_MODE); }
  finally { await handle.close(); }
  await statPrivate(path, bytes.length, PRIVATE_OUTPUT_MODE, MAX_PDF_ACROFORM_CHECKBOX_OUTPUT_BYTES);
}

async function statPrivate(path, expectedSize, expectedMode, maximumBytes) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximumBytes) fail('ACROFORM_CHECKBOX_INPUT_TOO_LARGE', 'The AcroForm checkbox file exceeds its fixed bound.', 413);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { const info = await handle.stat({ bigint: true }); if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(expectedSize) || (info.mode & 0o777n) !== BigInt(expectedMode)) fail('ACROFORM_CHECKBOX_TAMPERED', 'A private AcroForm checkbox file has unsafe metadata.', 502); return info; }
  finally { await handle.close(); }
}

export async function runAcroFormCheckboxJob({ store, documentId, source, request, deadline, lifecycle }) {
  throwIfAborted(deadline.signal); await store.verifySource(documentId);
  const workspace = await store.createJobWorkspace(documentId); lifecycle.workspace = workspace;
  await assertWorkspace(workspace, ACROFORM_CHECKBOX_BEFORE_FILES);
  const sourcePath = join(workspace, 'source.pdf');
  const sourceIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: sourcePath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_CHECKBOX_SOURCE_BYTES, signal: deadline.signal });
  await assertWorkspace(workspace, ['source.pdf']);
  const sourceRead = await readPrivate(sourcePath, source.size, PRIVATE_SOURCE_MODE, MAX_PDF_ACROFORM_CHECKBOX_SOURCE_BYTES);
  await assertPrivateSourceCopy({ path: sourcePath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_CHECKBOX_SOURCE_BYTES });
  throwIfAborted(deadline.signal);
  let built; try { built = preparePdfAcroFormCheckbox(sourceRead.bytes, request); } catch (error) { throw error; }
  if (!built?.proof || !Buffer.isBuffer(built.bytes) || built.bytes.length > MAX_PDF_ACROFORM_CHECKBOX_OUTPUT_BYTES) fail('ACROFORM_CHECKBOX_OUTPUT_INVALID', 'The AcroForm checkbox core returned an invalid bounded output.', 502);
  const outputPath = join(workspace, 'output.pdf'); await writePrivate(outputPath, built.bytes);
  await assertWorkspace(workspace, ACROFORM_CHECKBOX_AFTER_FILES);
  const outputRead = await readPrivate(outputPath, built.bytes.length, PRIVATE_OUTPUT_MODE, MAX_PDF_ACROFORM_CHECKBOX_OUTPUT_BYTES);
  if (!outputRead.bytes.equals(built.bytes)) fail('ACROFORM_CHECKBOX_TAMPERED', 'The AcroForm checkbox output changed before inspection.', 502);
  let inspected; try { inspected = inspectPdfAcroFormCheckbox(sourceRead.bytes, outputRead.bytes, request); } catch (error) { fail('ACROFORM_CHECKBOX_OUTPUT_INVALID', 'Independent AcroForm checkbox inspection rejected the output.', 502, error); }
  const expectedInspection = Object.freeze({ ...built.proof, otherPagesContentResourcesPreserved: true });
  if (JSON.stringify(inspected) !== JSON.stringify(expectedInspection)) fail('ACROFORM_CHECKBOX_OUTPUT_INVALID', 'Independent inspection disagreed with the checkbox proof.', 502);
  await assertPrivateSourceCopy({ path: sourcePath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_CHECKBOX_SOURCE_BYTES });
  const sourceAgain = await readPrivate(sourcePath, source.size, PRIVATE_SOURCE_MODE, MAX_PDF_ACROFORM_CHECKBOX_SOURCE_BYTES);
  if (!sourceAgain.bytes.equals(sourceRead.bytes)) fail('ACROFORM_CHECKBOX_SOURCE_TAMPERED', 'The staged immutable source changed during checkbox authoring.', 500);
  await store.verifySource(documentId); throwIfAborted(deadline.signal);
  const outputSha256 = digest(outputRead.bytes);
  const provenance = createOperationProvenance({
    type: 'pdf-acroform-checkbox', inputs: [{ documentId, sha256: source.sha256, role: 'source' }],
    parameters: { profile: PDF_ACROFORM_CHECKBOX_PROFILE, fieldNameSha256: built.proof.fieldNameSha256, page: built.proof.page, rect: built.proof.rect, stateName: built.proof.stateName },
    expected: { outputSha256, sourcePrefixPreserved: true, unchecked: true, signaturePreservation: false, otherPagesContentResourcesPreserved: true },
    validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'bounded-acroform-checkbox-core', 'independent-checkbox-reinspection', 'output-sha256'], outputSha256 },
  });
  const outputBeforePromotion = await readPrivate(outputPath, built.bytes.length, PRIVATE_OUTPUT_MODE, MAX_PDF_ACROFORM_CHECKBOX_OUTPUT_BYTES);
  if (!outputBeforePromotion.bytes.equals(outputRead.bytes) || !sameIdentity(outputBeforePromotion.identity, outputRead.identity) || digest(outputBeforePromotion.bytes) !== outputSha256) fail('ACROFORM_CHECKBOX_TAMPERED', 'The AcroForm checkbox output changed before promotion.', 502);
  lifecycle.promotedArtifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: 'checkbox-form.pdf', operation: provenance, expectedSha256: outputSha256, signal: deadline.signal });
  if (lifecycle.promotedArtifact.sha256 !== outputSha256 || lifecycle.promotedArtifact.id === source.id) fail('ACROFORM_CHECKBOX_OUTPUT_INVALID', 'The promoted AcroForm checkbox artifact does not match the inspected output.', 502);
  throwIfAborted(deadline.signal); lifecycle.completed = true;
  built.bytes.fill(0); outputRead.bytes.fill(0); outputBeforePromotion.bytes.fill(0); sourceRead.bytes.fill(0); sourceAgain.bytes.fill(0);
  return Object.freeze({ artifact: lifecycle.promotedArtifact, proof: inspected, limitations: Object.freeze(['One unchecked checkbox field only; no radio buttons, push buttons, calculations, actions, XFA, or general form editing.', 'Historical source bytes are retained; no signature preservation or PDF/UA claim is made.']) });
}

export async function cleanupAcroFormCheckboxJob({ store, lifecycle }) {
  let workspaceError = null; let artifactError = null;
  if (lifecycle.workspace) { try { await store.cleanupJob(lifecycle.workspace); } catch (error) { workspaceError = error; } }
  if ((!lifecycle.completed || workspaceError) && lifecycle.promotedArtifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.id); } catch (error) { artifactError = error; } }
  if (workspaceError || artifactError) fail('ACROFORM_CHECKBOX_CLEANUP_FAILED', 'AcroForm checkbox processing could not clean its private workspace or revoke its artifact.', 500, workspaceError ?? artifactError);
}
