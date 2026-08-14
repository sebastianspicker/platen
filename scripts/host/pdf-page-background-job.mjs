import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { PDF_PAGE_BACKGROUND_LIMITS, PDF_PAGE_BACKGROUND_PROFILE } from './pdf-page-background-contract.mjs';
const PDF_PAGE_BACKGROUND_LIMITATIONS = Object.freeze([
  'Only opaque solid RGB fills behind selected unrotated pages whose CropBox exactly equals MediaBox are supported.',
  'This local operation does not provide transparency, images, templates, bleed handling, or cross-viewer equivalence.',
  'The source revision remains the historical prefix; the result is an append-only incremental revision.',
]);
import { inspectPdfPageBackground, writePdfPageBackground } from './pdf-page-background-writer.mjs';

const MAX_OUTPUT_BYTES = PDF_PAGE_BACKGROUND_LIMITS.maxSourceBytes + (1 * 1024 * 1024);
const CORE = Object.freeze({ writePdfPageBackground, inspectPdfPageBackground });
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);
function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function abort(signal) { if (signal?.aborted) throw signal.reason ?? new Error('Page-background processing was cancelled.'); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameIdentity(a, b) { return IDENTITY_KEYS.every((key) => a[key] === b[key]); }
function privateIdentity(stat) { return Object.freeze(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, stat[key]]))); }
async function readPrivateFile(path, identity, expectedSha256, expectedSize, maximumBytes) {
  let handle = null;
  try { handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); const before = await handle.stat({ bigint: true }); if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n || before.size !== BigInt(expectedSize) || !sameIdentity(before, identity)) fail('PDF_PAGE_BACKGROUND_WORKSPACE_INVALID', 'The private page-background workspace file was replaced or made public.'); const bytes = await handle.readFile(); if (bytes.length !== expectedSize || bytes.length > maximumBytes || digest(bytes) !== expectedSha256 || !sameIdentity(before, await handle.stat({ bigint: true }))) fail('PDF_PAGE_BACKGROUND_WORKSPACE_INVALID', 'The private page-background workspace file changed during reading.'); return bytes; } finally { await handle?.close().catch(() => {}); }
}
async function writePrivateOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_OUTPUT_BYTES) fail('PDF_PAGE_BACKGROUND_OUTPUT_INVALID', 'The page-background writer returned an invalid bounded PDF output.');
  let handle = null;
  try { handle = await open(path, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await chmod(path, 0o400); const check = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); try { return privateIdentity(await check.stat({ bigint: true })); } finally { await check.close(); } } catch (error) { await handle?.close().catch(() => {}); await unlink(path).catch(() => {}); fail('PDF_PAGE_BACKGROUND_OUTPUT_INVALID', 'The page-background output could not be staged privately.', 502, error); }
}
async function workspaceNames(path) { return (await readdir(path, { withFileTypes: true })).map((entry) => entry.name).sort(); }

export async function runPdfPageBackgroundJob({ store, documentId, source, request, deadline, lifecycle, core = CORE }) {
  abort(deadline.signal); await store.verifySource(documentId); const workspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(workspace); const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf'); let writtenBytes = null;
  try {
    if (JSON.stringify(await workspaceNames(workspace)) !== '[]') fail('PDF_PAGE_BACKGROUND_WORKSPACE_INVALID', 'The private workspace was not empty before staging.');
    const inputIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: PDF_PAGE_BACKGROUND_LIMITS.maxSourceBytes, signal: deadline.signal });
    await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: PDF_PAGE_BACKGROUND_LIMITS.maxSourceBytes });
    const sourceBytes = await readPrivateFile(inputPath, inputIdentity, source.sha256, source.size, PDF_PAGE_BACKGROUND_LIMITS.maxSourceBytes); lifecycle.sourceBytes = sourceBytes; if (JSON.stringify(await workspaceNames(workspace)) !== JSON.stringify(['input.pdf'])) fail('PDF_PAGE_BACKGROUND_WORKSPACE_INVALID', 'The private workspace contains unexpected files before authoring.'); abort(deadline.signal);
    let written = core.writePdfPageBackground(sourceBytes, request); if (!written?.proof || !Buffer.isBuffer(written.bytes)) fail('PDF_PAGE_BACKGROUND_OUTPUT_INVALID', 'The page-background writer returned an invalid result.'); if (!written.bytes.subarray(0, sourceBytes.length).equals(sourceBytes)) fail('PDF_PAGE_BACKGROUND_OUTPUT_INVALID', 'The page-background writer changed the source prefix.');
    const writtenProof = written.proof; writtenBytes = Buffer.from(written.bytes); lifecycle.outputBytes = writtenBytes; const outputIdentity = await writePrivateOutput(outputPath, writtenBytes); written.bytes.fill(0); written = null;
    lifecycle.outputBytes = await readPrivateFile(outputPath, outputIdentity, digest(writtenBytes), writtenBytes.length, MAX_OUTPUT_BYTES); writtenBytes.fill(0);
    await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: PDF_PAGE_BACKGROUND_LIMITS.maxSourceBytes });
    const proof = core.inspectPdfPageBackground(sourceBytes, lifecycle.outputBytes, request); if (JSON.stringify(proof) !== JSON.stringify(writtenProof)) fail('PDF_PAGE_BACKGROUND_OUTPUT_INVALID', 'Independent page-background reinspection disagreed with the writer proof.');
    const outputSha256 = digest(lifecycle.outputBytes); lifecycle.outputBytes.fill(0); lifecycle.outputBytes = await readPrivateFile(outputPath, outputIdentity, outputSha256, writtenBytes.length, MAX_OUTPUT_BYTES); writtenBytes.fill(0); if (JSON.stringify(await workspaceNames(workspace)) !== JSON.stringify(['input.pdf', 'output.pdf'])) fail('PDF_PAGE_BACKGROUND_WORKSPACE_INVALID', 'The private workspace contains unexpected files after authoring.');
    abort(deadline.signal); await store.verifySource(documentId); if (outputSha256 === source.sha256) fail('PDF_PAGE_BACKGROUND_OUTPUT_INVALID', 'The page-background output did not produce a distinct artifact digest.');
    const operation = createOperationProvenance({ type: 'pdf-solid-page-background', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDF_PAGE_BACKGROUND_PROFILE, pages: request.pages, color: request.color }, expected: { sourcePrefixPreserved: true, outputSha256 }, validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'page-background-proof', 'artifact-sha256'], outputSha256 } });
    lifecycle.promotedArtifact = { artifact: await store.promotePdfArtifact(documentId, outputPath, { displayName: 'page-background.pdf', operation, expectedSha256: outputSha256, signal: deadline.signal }) };
    if (!lifecycle.promotedArtifact.artifact || lifecycle.promotedArtifact.artifact.sha256 !== outputSha256 || lifecycle.promotedArtifact.artifact.id === source.id) fail('PDF_PAGE_BACKGROUND_OUTPUT_INVALID', 'The promoted page-background artifact did not match the validated output.');
    abort(deadline.signal); lifecycle.completed = true;
    return Object.freeze({ kind: 'pdf-solid-page-background', sourceDigest: source.sha256, artifact: lifecycle.promotedArtifact.artifact, pages: proof.pages, evidence: Object.freeze({ sourcePrefixPreserved: true, outputDigestBound: true, sourceUnchanged: true, onlySelectedPagesChanged: true, pageBoxesUnchanged: true, resourcesUnchanged: true, annotationsUnchanged: true, localOnly: true }), limitations: PDF_PAGE_BACKGROUND_LIMITATIONS });
  } catch (error) { writtenBytes?.fill(0); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); throw error; }
}
