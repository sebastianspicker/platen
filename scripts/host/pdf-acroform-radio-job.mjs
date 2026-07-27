import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { inspectPdfAcroFormRadio, PDF_ACROFORM_RADIO_PROFILE, preparePdfAcroFormRadio } from './pdf-acroform-radio-writer.mjs';

export const MAX_PDF_ACROFORM_RADIO_JOB_MS = 120_000;
export const MAX_PDF_ACROFORM_RADIO_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_ACROFORM_RADIO_OUTPUT_BYTES = MAX_PDF_ACROFORM_RADIO_SOURCE_BYTES + 512 * 1024;
const SOURCE_MODE = 0o400; const OUTPUT_MODE = 0o600;
function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function identity(a, b) { return ['dev', 'ino', 'nlink', 'size', 'mode', 'mtimeNs', 'ctimeNs'].every((k) => a[k] === b[k]); }
function abort(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'AcroForm radio processing was cancelled.', 499, signal.reason); }
async function workspace(path, expected) { const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700) fail('ACROFORM_RADIO_TAMPERED', 'The private radio workspace is unsafe.', 502); const actual = (await readdir(path)).sort(); const wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((x, i) => x !== wanted[i])) fail('ACROFORM_RADIO_TAMPERED', 'The private radio workspace contains unexpected files.', 502); }
async function readPrivate(path, size, mode, max) { if (!Number.isSafeInteger(size) || size < 1 || size > max) fail('ACROFORM_RADIO_INPUT_TOO_LARGE', 'The AcroForm radio file exceeds its bound.', 413); const h = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); try { const before = await h.stat({ bigint: true }); if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(size) || (before.mode & 0o777n) !== BigInt(mode)) fail('ACROFORM_RADIO_TAMPERED', 'The private radio file metadata is unsafe.', 502); const bytes = await h.readFile(); const after = await h.stat({ bigint: true }); if (bytes.length !== size || !identity(before, after)) fail('ACROFORM_RADIO_TAMPERED', 'The private radio file changed while reading.', 502); return { bytes, identity: before }; } finally { await h.close(); } }
async function writePrivate(path, bytes) { const h = await open(path, 'wx', OUTPUT_MODE); try { let offset = 0; while (offset < bytes.length) { const n = await h.write(bytes, offset, bytes.length - offset, offset); if (n.bytesWritten < 1) throw new Error('short write'); offset += n.bytesWritten; } await h.sync(); await h.chmod(OUTPUT_MODE); } finally { await h.close(); } }

export async function runAcroFormRadioJob({ store, documentId, source, request, deadline, lifecycle }) {
  abort(deadline.signal); await store.verifySource(documentId); const dir = await store.createJobWorkspace(documentId); lifecycle.workspace = dir; await workspace(dir, []);
  const sourcePath = join(dir, 'source.pdf'); const sourceIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: sourcePath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_RADIO_SOURCE_BYTES, signal: deadline.signal }); await workspace(dir, ['source.pdf']); const sourceRead = await readPrivate(sourcePath, source.size, SOURCE_MODE, MAX_PDF_ACROFORM_RADIO_SOURCE_BYTES); await assertPrivateSourceCopy({ path: sourcePath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_RADIO_SOURCE_BYTES }); abort(deadline.signal);
  let built; try { built = preparePdfAcroFormRadio(sourceRead.bytes, request); } catch (error) { throw error; } if (!built?.proof || !Buffer.isBuffer(built.bytes) || built.bytes.length > MAX_PDF_ACROFORM_RADIO_OUTPUT_BYTES) fail('ACROFORM_RADIO_OUTPUT_INVALID', 'The radio core returned an invalid bounded output.', 502);
  const outputPath = join(dir, 'output.pdf'); await writePrivate(outputPath, built.bytes); await workspace(dir, ['output.pdf', 'source.pdf']); const outputRead = await readPrivate(outputPath, built.bytes.length, OUTPUT_MODE, MAX_PDF_ACROFORM_RADIO_OUTPUT_BYTES); if (!outputRead.bytes.equals(built.bytes)) fail('ACROFORM_RADIO_TAMPERED', 'The radio output changed before inspection.', 502); let inspected; try { inspected = inspectPdfAcroFormRadio(sourceRead.bytes, outputRead.bytes, request); } catch (error) { fail('ACROFORM_RADIO_OUTPUT_INVALID', 'Independent radio inspection rejected the output.', 502, error); } if (JSON.stringify(inspected) !== JSON.stringify(built.proof)) fail('ACROFORM_RADIO_OUTPUT_INVALID', 'Independent radio inspection disagreed with the proof.', 502);
  await assertPrivateSourceCopy({ path: sourcePath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_RADIO_SOURCE_BYTES });
  await store.verifySource(documentId);
  abort(deadline.signal);
  const outputSha256 = digest(outputRead.bytes);
  const provenance = createOperationProvenance({ type: 'pdf-acroform-radio', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDF_ACROFORM_RADIO_PROFILE, groupNameSha256: built.proof.groupNameSha256, optionLabelSha256: built.proof.optionLabelSha256, optionCount: built.proof.options.length }, expected: { outputSha256, sourcePrefixPreserved: true, unchecked: true, signaturePreservation: false }, validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'bounded-acroform-radio-core', 'independent-radio-reinspection', 'output-sha256'], outputSha256 } });
  const before = await readPrivate(outputPath, built.bytes.length, OUTPUT_MODE, MAX_PDF_ACROFORM_RADIO_OUTPUT_BYTES);
  if (digest(before.bytes) !== outputSha256 || !identity(before.identity, outputRead.identity)) fail('ACROFORM_RADIO_TAMPERED', 'The radio output changed before promotion.', 502);
  lifecycle.promotedArtifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: 'radio-form.pdf', operation: provenance, expectedSha256: outputSha256, signal: deadline.signal });
  if (lifecycle.promotedArtifact.sha256 !== outputSha256 || lifecycle.promotedArtifact.id === source.id) fail('ACROFORM_RADIO_OUTPUT_INVALID', 'The promoted radio artifact is invalid.', 502);
  abort(deadline.signal);
  lifecycle.completed = true;
  built.bytes.fill(0);
  outputRead.bytes.fill(0);
  before.bytes.fill(0);
  sourceRead.bytes.fill(0);
  return Object.freeze({ artifact: lifecycle.promotedArtifact, proof: inspected, limitations: Object.freeze(['One unchecked radio group only; no selection logic, calculations, actions, XFA, general form editing, or signature preservation.']) });
}
export async function cleanupAcroFormRadioJob({ store, lifecycle }) { let workspaceError = null; let artifactError = null; if (lifecycle.workspace) { try { await store.cleanupJob(lifecycle.workspace); } catch (e) { workspaceError = e; } } if ((!lifecycle.completed || workspaceError) && lifecycle.promotedArtifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.id); } catch (e) { artifactError = e; } } if (workspaceError || artifactError) fail('ACROFORM_RADIO_CLEANUP_FAILED', 'AcroForm radio processing could not clean its workspace or revoke its artifact.', 500, workspaceError ?? artifactError); }
