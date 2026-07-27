import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { inspectPdfAcroFormChoice, PDF_ACROFORM_CHOICE_PROFILE, preparePdfAcroFormChoice } from './pdf-acroform-choice-writer.mjs';

export const MAX_PDF_ACROFORM_CHOICE_JOB_MS = 120_000;
export const MAX_PDF_ACROFORM_CHOICE_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_ACROFORM_CHOICE_OUTPUT_BYTES = MAX_PDF_ACROFORM_CHOICE_SOURCE_BYTES + 512 * 1024;

function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function identity(left, right) { return ['dev', 'ino', 'nlink', 'size', 'mode', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]); }
function abort(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'AcroForm choice processing was cancelled.', 499, signal.reason); }

async function assertWorkspace(directory, expected) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) fail('ACROFORM_CHOICE_TAMPERED', 'The private choice workspace is unsafe.');
  const actual = (await readdir(directory)).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) fail('ACROFORM_CHOICE_TAMPERED', 'The private choice workspace contains unexpected files.');
}
async function readPrivate(path, size, mode, maximum) {
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) fail('ACROFORM_CHOICE_INPUT_TOO_LARGE', 'The choice file exceeds its bound.', 413);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(size) || (before.mode & 0o777n) !== BigInt(mode)) fail('ACROFORM_CHOICE_TAMPERED', 'The private choice file metadata is unsafe.');
    const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true });
    if (bytes.length !== size || !identity(before, after)) fail('ACROFORM_CHOICE_TAMPERED', 'The private choice file changed while reading.');
    return { bytes, identity: before };
  } finally { await handle.close(); }
}
async function writePrivate(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset, offset); if (result.bytesWritten < 1) throw new Error('short write'); offset += result.bytesWritten; } await handle.sync(); }
  finally { await handle.close(); }
}

export async function runAcroFormChoiceJob({ store, documentId, source, request, deadline, lifecycle }) {
  let sourceRead = null; let outputRead = null; let before = null; let built = null;
  try {
    abort(deadline.signal); await store.verifySource(documentId); const directory = await store.createJobWorkspace(documentId); lifecycle.workspace = directory; await assertWorkspace(directory, []);
    const sourcePath = join(directory, 'source.pdf');
    const sourceIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: sourcePath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_CHOICE_SOURCE_BYTES, signal: deadline.signal });
    await assertWorkspace(directory, ['source.pdf']); sourceRead = await readPrivate(sourcePath, source.size, 0o400, MAX_PDF_ACROFORM_CHOICE_SOURCE_BYTES);
    await assertPrivateSourceCopy({ path: sourcePath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_CHOICE_SOURCE_BYTES }); abort(deadline.signal);
    built = preparePdfAcroFormChoice(sourceRead.bytes, request); if (!built?.proof || !Buffer.isBuffer(built.bytes) || built.bytes.length > MAX_PDF_ACROFORM_CHOICE_OUTPUT_BYTES) fail('ACROFORM_CHOICE_OUTPUT_INVALID', 'The choice core returned an invalid output.');
    const outputPath = join(directory, 'output.pdf'); await writePrivate(outputPath, built.bytes); await assertWorkspace(directory, ['output.pdf', 'source.pdf']);
    outputRead = await readPrivate(outputPath, built.bytes.length, 0o600, MAX_PDF_ACROFORM_CHOICE_OUTPUT_BYTES); if (!outputRead.bytes.equals(built.bytes)) fail('ACROFORM_CHOICE_TAMPERED', 'The choice output changed before inspection.');
    let inspected; try { inspected = inspectPdfAcroFormChoice(sourceRead.bytes, outputRead.bytes, request); } catch (error) { fail('ACROFORM_CHOICE_OUTPUT_INVALID', 'Independent choice inspection rejected the output.', 502, error); }
    if (JSON.stringify(inspected) !== JSON.stringify(built.proof)) fail('ACROFORM_CHOICE_OUTPUT_INVALID', 'Independent choice inspection disagreed with the proof.');
    await assertPrivateSourceCopy({ path: sourcePath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_CHOICE_SOURCE_BYTES }); await store.verifySource(documentId); abort(deadline.signal);
    const outputSha256 = digest(outputRead.bytes); const provenance = createOperationProvenance({ type: 'pdf-acroform-choice', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDF_ACROFORM_CHOICE_PROFILE, page: built.proof.page, fieldNameSha256: built.proof.fieldNameSha256, optionLabelSha256: built.proof.optionLabelSha256, optionCount: built.proof.options.length }, expected: { outputSha256, sourcePrefixPreserved: true, unchecked: true }, validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'bounded-acroform-choice-core', 'independent-choice-reinspection', 'output-sha256'], outputSha256 } });
    before = await readPrivate(outputPath, built.bytes.length, 0o600, MAX_PDF_ACROFORM_CHOICE_OUTPUT_BYTES); if (digest(before.bytes) !== outputSha256 || !identity(before.identity, outputRead.identity)) fail('ACROFORM_CHOICE_TAMPERED', 'The choice output changed before promotion.');
    lifecycle.promotedArtifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: 'choice-form.pdf', operation: provenance, expectedSha256: outputSha256, signal: deadline.signal });
    const artifact = lifecycle.promotedArtifact; if (artifact.documentId !== documentId || artifact.id === source.id || artifact.sha256 !== outputSha256 || artifact.size !== outputRead.bytes.length) fail('ACROFORM_CHOICE_OUTPUT_INVALID', 'The promoted choice artifact identity is invalid.');
    abort(deadline.signal); lifecycle.completed = true;
    return Object.freeze({ artifact, proof: inspected, limitations: Object.freeze(['One unchecked non-combo choice field only; no selection logic, calculations, actions, XFA, general form editing, or signature preservation.']) });
  } finally {
    for (const value of [built?.bytes, sourceRead?.bytes, outputRead?.bytes, before?.bytes]) if (Buffer.isBuffer(value)) value.fill(0);
  }
}
export async function cleanupAcroFormChoiceJob({ store, lifecycle }) {
  let workspaceError = null; let artifactError = null;
  if (lifecycle.workspace) { try { await store.cleanupJob(lifecycle.workspace); } catch (error) { workspaceError = error; } }
  if ((!lifecycle.completed || workspaceError) && lifecycle.promotedArtifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.id); } catch (error) { artifactError = error; } }
  if (workspaceError || artifactError) fail('ACROFORM_CHOICE_CLEANUP_FAILED', 'AcroForm choice cleanup failed.', 500, workspaceError ?? artifactError);
}
