import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { PDF_PAGE_WATERMARK_LIMITS, PDF_PAGE_WATERMARK_PROFILE } from './pdf-page-watermark-contract.mjs';
import { inspectPdfPageWatermark, writePdfPageWatermark } from './pdf-page-watermark-writer.mjs';

export const MAX_PDF_PAGE_WATERMARK_JOB_MS = 120_000;
export const MAX_PDF_PAGE_WATERMARK_SOURCE_BYTES = PDF_PAGE_WATERMARK_LIMITS.maxSourceBytes;
export const MAX_PDF_PAGE_WATERMARK_OUTPUT_BYTES = MAX_PDF_PAGE_WATERMARK_SOURCE_BYTES + 512 * 1024;
const CORE = Object.freeze({ writePdfPageWatermark, inspectPdfPageWatermark });
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);
function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function abort(signal) { if (signal?.aborted) fail('JOB_CANCELLED', 'Page watermarking was cancelled.', 499); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameIdentity(a, b) { return IDENTITY_KEYS.every((key) => a[key] === b[key]); }
function privateIdentity(stat) { return Object.freeze(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, stat[key]]))); }
async function readPrivateFile(path, identity, expectedSha256, expectedSize, maximumBytes) {
  let handle = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n || before.size !== BigInt(expectedSize) || !sameIdentity(before, identity)) fail('PDF_PAGE_WATERMARK_WORKSPACE_INVALID', 'The private page-watermark workspace file was replaced or made public.');
    const bytes = await handle.readFile(); if (bytes.length !== expectedSize || bytes.length > maximumBytes || digest(bytes) !== expectedSha256 || !sameIdentity(before, await handle.stat({ bigint: true }))) fail('PDF_PAGE_WATERMARK_WORKSPACE_INVALID', 'The private page-watermark workspace file changed during reading.');
    return bytes;
  } finally { await handle?.close().catch(() => {}); }
}
async function writePrivateOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_PDF_PAGE_WATERMARK_OUTPUT_BYTES) fail('PDF_PAGE_WATERMARK_OUTPUT_INVALID', 'The page-watermark writer returned an invalid bounded PDF output.');
  let handle = null;
  try { handle = await open(path, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await chmod(path, 0o400); const check = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); try { return privateIdentity(await check.stat({ bigint: true })); } finally { await check.close(); } }
  catch (error) { await handle?.close().catch(() => {}); await unlink(path).catch(() => {}); fail('PDF_PAGE_WATERMARK_OUTPUT_INVALID', 'The page-watermark output could not be staged privately.', 502, error); }
}
async function workspaceNames(path) { return (await readdir(path, { withFileTypes: true })).map((entry) => entry.name).sort(); }

export async function runPdfPageWatermarkJob({ store, documentId, source, request, deadline, lifecycle, core = CORE }) {
  abort(deadline.signal); await store.verifySource(documentId); const workspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(workspace); const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf'); let writtenBytes = null;
  try {
    if (JSON.stringify(await workspaceNames(workspace)) !== '[]') fail('PDF_PAGE_WATERMARK_WORKSPACE_INVALID', 'The private workspace was not empty before staging.');
    const inputIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_PAGE_WATERMARK_SOURCE_BYTES, signal: deadline.signal });
    await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_PAGE_WATERMARK_SOURCE_BYTES });
    const sourceBytes = await readPrivateFile(inputPath, inputIdentity, source.sha256, source.size, MAX_PDF_PAGE_WATERMARK_SOURCE_BYTES); lifecycle.sourceBytes = sourceBytes;
    if (JSON.stringify(await workspaceNames(workspace)) !== JSON.stringify(['input.pdf'])) fail('PDF_PAGE_WATERMARK_WORKSPACE_INVALID', 'The private workspace contains unexpected files before authoring.'); abort(deadline.signal);
    let written = core.writePdfPageWatermark(sourceBytes, request); if (!written?.proof || !Buffer.isBuffer(written.bytes)) fail('PDF_PAGE_WATERMARK_OUTPUT_INVALID', 'The page-watermark writer returned an invalid result.'); if (!written.bytes.subarray(0, sourceBytes.length).equals(sourceBytes)) fail('PDF_PAGE_WATERMARK_OUTPUT_INVALID', 'The page-watermark writer changed the source prefix.');
    const writtenProof = written.proof; writtenBytes = Buffer.from(written.bytes); lifecycle.outputBytes = writtenBytes; const outputIdentity = await writePrivateOutput(outputPath, writtenBytes); written.bytes.fill(0); written = null;
    lifecycle.outputBytes = await readPrivateFile(outputPath, outputIdentity, digest(writtenBytes), writtenBytes.length, MAX_PDF_PAGE_WATERMARK_OUTPUT_BYTES); writtenBytes.fill(0);
    await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_PDF_PAGE_WATERMARK_SOURCE_BYTES });
    let proof; try { proof = core.inspectPdfPageWatermark(sourceBytes, lifecycle.outputBytes, request); } catch (error) { if (error?.code === 'UNSUPPORTED_PDF_PAGE_WATERMARK' || error?.code === 'INVALID_PDF_PAGE_WATERMARK') throw error; fail('PDF_PAGE_WATERMARK_OUTPUT_INVALID', 'Independent page-watermark reinspection rejected the output.', 502, error); } if (JSON.stringify(proof) !== JSON.stringify(writtenProof)) fail('PDF_PAGE_WATERMARK_OUTPUT_INVALID', 'Independent page-watermark reinspection disagreed with the writer proof.');
    const outputSha256 = digest(lifecycle.outputBytes); lifecycle.outputBytes.fill(0); lifecycle.outputBytes = await readPrivateFile(outputPath, outputIdentity, outputSha256, writtenBytes.length, MAX_PDF_PAGE_WATERMARK_OUTPUT_BYTES); writtenBytes.fill(0);
    let finalProof; try { finalProof = core.inspectPdfPageWatermark(sourceBytes, lifecycle.outputBytes, request); } catch (error) { fail('PDF_PAGE_WATERMARK_OUTPUT_INVALID', 'Final page-watermark reinspection rejected the retained output.', 502, error); } if (JSON.stringify(finalProof) !== JSON.stringify(proof)) fail('PDF_PAGE_WATERMARK_OUTPUT_INVALID', 'Final page-watermark reinspection disagreed with the retained output.');
    if (JSON.stringify(await workspaceNames(workspace)) !== JSON.stringify(['input.pdf', 'output.pdf'])) fail('PDF_PAGE_WATERMARK_WORKSPACE_INVALID', 'The private workspace contains unexpected files after authoring.'); abort(deadline.signal); await store.verifySource(documentId); if (outputSha256 === source.sha256) fail('PDF_PAGE_WATERMARK_OUTPUT_INVALID', 'The page-watermark output did not produce a distinct artifact digest.');
    const textHash = createHash('sha256').update(request.text, 'utf8').digest('hex'); const operation = createOperationProvenance({ type: 'pdf-page-watermark', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDF_PAGE_WATERMARK_PROFILE, pages: request.pages, textSha256: textHash }, expected: { sourcePrefixPreserved: true, outputSha256 }, validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'page-watermark-proof', 'artifact-sha256'], outputSha256 } });
    lifecycle.promotedArtifact = { artifact: await store.promotePdfArtifact(documentId, outputPath, { displayName: 'page-watermarked.pdf', operation, expectedSha256: outputSha256, signal: deadline.signal }) };
    if (!lifecycle.promotedArtifact.artifact || lifecycle.promotedArtifact.artifact.sha256 !== outputSha256 || lifecycle.promotedArtifact.artifact.id === source.id) fail('PDF_PAGE_WATERMARK_OUTPUT_INVALID', 'The promoted page-watermark artifact did not match the validated output.');
    try { abort(deadline.signal); } catch (error) { try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch (revokeError) { fail('PDF_PAGE_WATERMARK_CLEANUP_FAILED', 'Promoted page-watermark artifact could not be revoked after cancellation.', 500, revokeError); } lifecycle.promotedArtifact = null; throw error; }
    lifecycle.completed = true; return Object.freeze({ artifact: lifecycle.promotedArtifact.artifact, proof: finalProof, limitations: PDF_PAGE_WATERMARK_LIMITATIONS });
  } catch (error) { writtenBytes?.fill(0); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); throw error; }
}

export const PDF_PAGE_WATERMARK_LIMITATIONS = Object.freeze([
  'Only one opaque black Helvetica text watermark is added to selected unrotated pages in the supported classic PDF subset.',
  'This operation does not update or remove marks and does not support images, transparency, templates, rotated or complex pages, forms, actions, tags, layers, signatures, or document sets.',
  'The source revision remains the historical prefix; the result is a separately retained append-only artifact.',
]);

export async function cleanupPdfPageWatermarkJob({ store, lifecycle }) {
  const results = await Promise.allSettled((lifecycle.workspaces ?? []).reverse().map((workspace) => store.cleanupJob(workspace))); let failureSeen = results.some(({ status }) => status === 'rejected');
  if ((!lifecycle.completed || failureSeen) && lifecycle.promotedArtifact?.artifact?.id) { try { await store.deleteArtifact(lifecycle.promotedArtifact.artifact.id); } catch { failureSeen = true; } }
  if (failureSeen) fail('PDF_PAGE_WATERMARK_CLEANUP_FAILED', 'Page-watermark processing could not clean its private workspace.', 500);
}
