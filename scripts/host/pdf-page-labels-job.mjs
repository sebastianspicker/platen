import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { PDF_PAGE_LABELS_PROFILE, inspectPdfPageLabels, writePdfPageLabels } from './pdf-page-labels-writer.mjs';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_SOURCE_BYTES + (2 * 1024 * 1024);
const CORE = Object.freeze({ writePdfPageLabels, inspectPdfPageLabels });
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);
function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function abort(signal) { if (signal?.aborted) throw signal.reason ?? new Error('Page-label processing was cancelled.'); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameIdentity(left, right) { return IDENTITY_KEYS.every((key) => left[key] === right[key]); }
function privateIdentity(stat) { return Object.freeze(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, stat[key]]))); }
async function readPrivateFile(path, identity, expectedSha256, expectedSize, maximumBytes) {
  let handle = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n || before.size !== BigInt(expectedSize) || !sameIdentity(before, identity)) fail('PDF_PAGE_LABELS_WORKSPACE_INVALID', 'The page-label workspace file was replaced or made public.');
    const bytes = await handle.readFile(); if (bytes.length !== expectedSize || bytes.length > maximumBytes || digest(bytes) !== expectedSha256) fail('PDF_PAGE_LABELS_WORKSPACE_INVALID', 'The page-label workspace file changed during reading.');
    if (!sameIdentity(before, await handle.stat({ bigint: true }))) fail('PDF_PAGE_LABELS_WORKSPACE_INVALID', 'The page-label workspace file changed during reading.');
    return bytes;
  } finally { await handle?.close().catch(() => {}); }
}
async function writePrivateOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_OUTPUT_BYTES) fail('PDF_PAGE_LABELS_OUTPUT_INVALID', 'The page-label writer returned an invalid bounded PDF output.');
  let handle = null;
  try {
    handle = await open(path, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await chmod(path, 0o400); const check = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); try { return privateIdentity(await check.stat({ bigint: true })); } finally { await check.close(); }
  } catch (error) { await handle?.close().catch(() => {}); await unlink(path).catch(() => {}); fail('PDF_PAGE_LABELS_OUTPUT_INVALID', 'The page-label output could not be staged privately.', 502, error); }
}

export async function runPdfPageLabelsJob({ store, documentId, source, request, deadline, lifecycle, core = CORE }) {
  abort(deadline.signal); await store.verifySource(documentId); const workspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(workspace);
  const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf'); let writtenBytes = null;
  try {
    const inputIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES, signal: deadline.signal });
    await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES });
    const sourceBytes = await readPrivateFile(inputPath, inputIdentity, source.sha256, source.size, MAX_SOURCE_BYTES); lifecycle.sourceBytes = sourceBytes; abort(deadline.signal);
    let written = core.writePdfPageLabels(sourceBytes, request); if (!written?.proof || !Buffer.isBuffer(written.bytes)) fail('PDF_PAGE_LABELS_OUTPUT_INVALID', 'The page-label writer returned an invalid result.');
    if (!written.bytes.subarray(0, sourceBytes.length).equals(sourceBytes)) fail('PDF_PAGE_LABELS_OUTPUT_INVALID', 'The page-label writer changed the source prefix.');
    const writtenProof = written.proof; writtenBytes = Buffer.from(written.bytes); lifecycle.outputBytes = writtenBytes; const outputIdentity = await writePrivateOutput(outputPath, writtenBytes); written.bytes.fill(0); written = null;
    lifecycle.outputBytes = await readPrivateFile(outputPath, outputIdentity, digest(writtenBytes), writtenBytes.length, MAX_OUTPUT_BYTES); writtenBytes.fill(0);
    await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES });
    const proof = core.inspectPdfPageLabels(sourceBytes, lifecycle.outputBytes, request); if (JSON.stringify(proof) !== JSON.stringify(writtenProof)) fail('PDF_PAGE_LABELS_OUTPUT_INVALID', 'Independent page-label reinspection disagreed with the writer proof.');
    abort(deadline.signal); await store.verifySource(documentId); const outputSha256 = digest(lifecycle.outputBytes); if (outputSha256 === source.sha256) fail('PDF_PAGE_LABELS_OUTPUT_INVALID', 'The page-label output did not produce a distinct artifact digest.');
    const operation = createOperationProvenance({ type: 'pdf-page-labels', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDF_PAGE_LABELS_PROFILE, ranges: proof.ranges }, expected: { sourcePrefixPreserved: true, outputSha256 }, validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'page-label-proof', 'artifact-sha256'], outputSha256 } });
    lifecycle.promotedArtifact = { artifact: await store.promotePdfArtifact(documentId, outputPath, { displayName: 'page-labels.pdf', operation, expectedSha256: outputSha256, signal: deadline.signal }) };
    if (!lifecycle.promotedArtifact.artifact || lifecycle.promotedArtifact.artifact.sha256 !== outputSha256 || lifecycle.promotedArtifact.artifact.id === source.id) fail('PDF_PAGE_LABELS_OUTPUT_INVALID', 'The promoted page-label artifact did not match the validated output.');
    abort(deadline.signal); lifecycle.completed = true;
    return Object.freeze({ kind: 'pdf-page-labels', sourceDigest: source.sha256, artifact: lifecycle.promotedArtifact.artifact, pageCount: proof.pageCount, ranges: proof.ranges, labels: proof.labels, evidence: Object.freeze({ sourcePrefixPreserved: true, outputDigestBound: true, sourceUnchanged: true, localOnly: true }), limitations: Object.freeze(['Only flat direct page trees and direct page-label dictionaries are supported.', 'This operation does not provide label-based navigation disambiguation or general number-tree editing.']) });
  } catch (error) { writtenBytes?.fill(0); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); throw error; }
}
