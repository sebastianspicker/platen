import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import {
  inspectPdfAcroFormTabOrderTooltip,
  preparePdfAcroFormTabOrderTooltip,
  PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE,
} from './pdf-acroform-tab-order-tooltip-writer.mjs';

export const MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_JOB_MS = 120_000;
export const MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_OUTPUT_BYTES = MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_SOURCE_BYTES + 512 * 1024;
const SOURCE_MODE = 0o400;
const OUTPUT_MODE = 0o600;

function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function identity(left, right) { return ['dev', 'ino', 'nlink', 'size', 'mode', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]); }
function abort(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'AcroForm tab-order and tooltip processing was cancelled.', 499, signal.reason); }
async function assertWorkspace(directory, expected) {
  const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) fail('ACROFORM_TAB_ORDER_TOOLTIP_TAMPERED', 'The private tab-order and tooltip workspace is unsafe.');
  const actual = (await readdir(directory)).sort(); const wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) fail('ACROFORM_TAB_ORDER_TOOLTIP_TAMPERED', 'The private tab-order and tooltip workspace contains unexpected files.');
}
async function readPrivate(path, size, mode, maximum) {
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) fail('ACROFORM_TAB_ORDER_TOOLTIP_INPUT_TOO_LARGE', 'The private tab-order and tooltip file exceeds its bound.', 413);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true }); if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(size) || (before.mode & 0o777n) !== BigInt(mode)) fail('ACROFORM_TAB_ORDER_TOOLTIP_TAMPERED', 'The private tab-order and tooltip file metadata is unsafe.');
    const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); if (bytes.length !== size || !identity(before, after)) fail('ACROFORM_TAB_ORDER_TOOLTIP_TAMPERED', 'The private tab-order and tooltip file changed while reading.');
    return { bytes, identity: before };
  } finally { await handle.close(); }
}
async function writePrivate(path, bytes) {
  const handle = await open(path, 'wx', OUTPUT_MODE);
  try { let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset, offset); if (result.bytesWritten < 1) throw new Error('short write'); offset += result.bytesWritten; } await handle.sync(); }
  finally { await handle.close(); }
}

export async function runAcroFormTabOrderTooltipJob({ store, documentId, source, request, deadline, lifecycle }) {
  let built = null; let sourceRead = null; let outputRead = null; let before = null;
  try {
    abort(deadline.signal); await store.verifySource(documentId); const directory = await store.createJobWorkspace(documentId); lifecycle.workspace = directory; await assertWorkspace(directory, []);
    const sourcePath = join(directory, 'source.pdf'); const sourceIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: sourcePath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_SOURCE_BYTES, signal: deadline.signal });
    await assertWorkspace(directory, ['source.pdf']); sourceRead = await readPrivate(sourcePath, source.size, SOURCE_MODE, MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_SOURCE_BYTES); await assertPrivateSourceCopy({ path: sourcePath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_SOURCE_BYTES }); abort(deadline.signal);
    built = preparePdfAcroFormTabOrderTooltip(sourceRead.bytes, request); if (!built?.proof || !Buffer.isBuffer(built.bytes) || built.bytes.length > MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_OUTPUT_BYTES) fail('ACROFORM_TAB_ORDER_TOOLTIP_OUTPUT_INVALID', 'The tab-order and tooltip writer returned an invalid bounded output.');
    const outputPath = join(directory, 'output.pdf'); await writePrivate(outputPath, built.bytes); await assertWorkspace(directory, ['output.pdf', 'source.pdf']); outputRead = await readPrivate(outputPath, built.bytes.length, OUTPUT_MODE, MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_OUTPUT_BYTES); if (!outputRead.bytes.equals(built.bytes)) fail('ACROFORM_TAB_ORDER_TOOLTIP_TAMPERED', 'The tab-order and tooltip output changed before inspection.');
    let inspected; try { inspected = inspectPdfAcroFormTabOrderTooltip(sourceRead.bytes, outputRead.bytes, request); } catch (error) { fail('ACROFORM_TAB_ORDER_TOOLTIP_OUTPUT_INVALID', 'Independent tab-order and tooltip inspection rejected the output.', 502, error); }
    if (JSON.stringify(inspected) !== JSON.stringify(built.proof)) fail('ACROFORM_TAB_ORDER_TOOLTIP_OUTPUT_INVALID', 'Independent inspection disagreed with the writer proof.');
    await assertPrivateSourceCopy({ path: sourcePath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_SOURCE_BYTES }); await store.verifySource(documentId); abort(deadline.signal);
    const outputSha256 = digest(outputRead.bytes); const provenance = createOperationProvenance({ type: 'pdf-acroform-tab-order-tooltip', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDF_ACROFORM_TAB_ORDER_TOOLTIP_PROFILE, page: built.proof.page, annotationIndex: built.proof.annotationIndex, fingerprint: built.proof.fingerprint, tooltipSha256: built.proof.tooltipSha256, tabOrder: 'S' }, expected: { outputSha256, sourcePrefixPreserved: true, changedObjectCount: 2, signaturePreservation: false }, validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'bounded-tab-order-tooltip-core', 'independent-tab-order-tooltip-reinspection', 'output-sha256'], outputSha256 } });
    before = await readPrivate(outputPath, built.bytes.length, OUTPUT_MODE, MAX_PDF_ACROFORM_TAB_ORDER_TOOLTIP_OUTPUT_BYTES); if (!before.bytes.equals(outputRead.bytes) || !identity(before.identity, outputRead.identity) || digest(before.bytes) !== outputSha256) fail('ACROFORM_TAB_ORDER_TOOLTIP_TAMPERED', 'The output changed before promotion.');
    const promotedArtifact = await store.promotePdfArtifact(documentId, outputPath, { displayName: 'tab-order-tooltip-form.pdf', operation: provenance, expectedSha256: outputSha256, signal: deadline.signal });
    if (!promotedArtifact || promotedArtifact.documentId !== documentId || promotedArtifact.sha256 !== outputSha256 || promotedArtifact.size !== outputRead.bytes.length || promotedArtifact.id === source.id) fail('ACROFORM_TAB_ORDER_TOOLTIP_OUTPUT_INVALID', 'The promoted artifact does not match the inspected output.');
    lifecycle.promotedArtifact = promotedArtifact;
    abort(deadline.signal); lifecycle.completed = true; return Object.freeze({ artifact: lifecycle.promotedArtifact, proof: inspected, limitations: Object.freeze(['One existing non-signature AcroForm widget tooltip and one selected page structural tab-order mode only; actions, JavaScript, XFA, signatures, tags, layers, ambiguous field graphs, and general form editing are rejected.', 'The source document is preserved in a separate derived artifact; no PDF/A, PDF/UA, or signature-preservation claim is made.']) });
  } finally { for (const value of [built?.bytes, sourceRead?.bytes, outputRead?.bytes, before?.bytes]) if (Buffer.isBuffer(value)) value.fill(0); }
}

export async function cleanupAcroFormTabOrderTooltipJob({ store, lifecycle }) {
  let workspaceError = null; let artifactError = null; if (lifecycle.workspace) { try { await store.cleanupJob(lifecycle.workspace); } catch (error) { workspaceError = error; } } if ((!lifecycle.completed || workspaceError) && lifecycle.promotedArtifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.id); } catch (error) { artifactError = error; } } if (workspaceError || artifactError) { const cause = workspaceError && artifactError ? new AggregateError([workspaceError, artifactError], 'Tab-order and tooltip cleanup had multiple failures.') : workspaceError ?? artifactError; fail('ACROFORM_TAB_ORDER_TOOLTIP_CLEANUP_FAILED', 'Tab-order and tooltip cleanup failed.', 500, cause); }
}
