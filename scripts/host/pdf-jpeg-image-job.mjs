import { createHash } from 'node:crypto';
import { chmod, open, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from './private-source-copy.mjs';
import { PDF_JPEG_IMAGE_PROFILE, inspectPdfJpegImage, writePdfJpegImage } from './pdf-jpeg-image-writer.mjs';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_SOURCE_BYTES + (16 * 1024 * 1024);
const CORE = Object.freeze({ writePdfJpegImage, inspectPdfJpegImage });

function fail(code, message, status = 502, cause) { throw new HostError(code, message, status, cause ? { cause } : undefined); }
function abort(signal) { if (signal?.aborted) throw signal.reason ?? new Error('JPEG image processing was cancelled.'); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);
function sameIdentity(left, right) { return IDENTITY_KEYS.every((key) => left[key] === right[key]); }
function privateIdentity(stat) { return Object.freeze(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, stat[key]]))); }
async function readPrivateFile(path, identity, expectedSha256, expectedSize, maximumBytes) {
  let handle = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n || before.size !== BigInt(expectedSize) || !sameIdentity(before, identity)) fail('PDF_JPEG_IMAGE_WORKSPACE_INVALID', 'The JPEG image workspace contains an unsafe or replaced file.');
    const bytes = await handle.readFile();
    if (bytes.length !== expectedSize || bytes.length > maximumBytes || digest(bytes) !== expectedSha256) fail('PDF_JPEG_IMAGE_WORKSPACE_INVALID', 'The JPEG image workspace file changed during reading.');
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) fail('PDF_JPEG_IMAGE_WORKSPACE_INVALID', 'The JPEG image workspace file changed during reading.');
    return bytes;
  } finally { await handle?.close().catch(() => {}); }
}
async function writePrivateOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_OUTPUT_BYTES) fail('PDF_JPEG_IMAGE_OUTPUT_INVALID', 'The JPEG image writer returned an invalid bounded PDF output.');
  let handle = null;
  try { handle = await open(path, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await chmod(path, 0o400); const stat = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); try { return privateIdentity(await stat.stat({ bigint: true })); } finally { await stat.close(); } }
  catch (error) { await handle?.close().catch(() => {}); await unlink(path).catch(() => {}); fail('PDF_JPEG_IMAGE_OUTPUT_INVALID', 'The JPEG image output could not be staged privately.', 502, error); }
}

export async function runPdfJpegImageJob({ store, documentId, source, request, deadline, lifecycle, core = CORE }) {
  abort(deadline.signal); await store.verifySource(documentId);
  const workspace = await store.createJobWorkspace(documentId); lifecycle.workspaces.push(workspace);
  const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf');
  let writtenBytes = null;
  try {
    const inputIdentity = await stagePrivateSourceCopy({ sourcePath: store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES, signal: deadline.signal });
    await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES });
    const sourceBytes = await readPrivateFile(inputPath, inputIdentity, source.sha256, source.size, MAX_SOURCE_BYTES); lifecycle.sourceBytes = sourceBytes; abort(deadline.signal);
    let written = core.writePdfJpegImage(sourceBytes, request); if (!written?.proof || !Buffer.isBuffer(written.bytes)) fail('PDF_JPEG_IMAGE_OUTPUT_INVALID', 'The JPEG image writer returned an invalid result.');
    if (!written.bytes.subarray(0, sourceBytes.length).equals(sourceBytes)) fail('PDF_JPEG_IMAGE_OUTPUT_INVALID', 'The JPEG image writer changed the source prefix.');
    const writtenProof = written.proof; writtenBytes = Buffer.from(written.bytes); lifecycle.outputBytes = writtenBytes; const outputIdentity = await writePrivateOutput(outputPath, writtenBytes); written.bytes.fill(0); written = null;
    lifecycle.outputBytes = await readPrivateFile(outputPath, outputIdentity, digest(writtenBytes), writtenBytes.length, MAX_OUTPUT_BYTES); writtenBytes.fill(0);
    await assertPrivateSourceCopy({ path: inputPath, identity: inputIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES });
    const proof = core.inspectPdfJpegImage(sourceBytes, lifecycle.outputBytes, request); if (JSON.stringify(proof) !== JSON.stringify(writtenProof)) fail('PDF_JPEG_IMAGE_OUTPUT_INVALID', 'JPEG image reinspection disagreed with the writer proof.');
    abort(deadline.signal); await store.verifySource(documentId);
    const outputSha256 = digest(lifecycle.outputBytes); if (outputSha256 === source.sha256) fail('PDF_JPEG_IMAGE_OUTPUT_INVALID', 'The JPEG image output did not produce a distinct artifact digest.');
    const operation = createOperationProvenance({ type: 'pdf-jpeg-image', inputs: [{ documentId, sha256: source.sha256, role: 'source' }], parameters: { profile: PDF_JPEG_IMAGE_PROFILE, page: proof.page, rect: proof.rect, image: proof.image }, expected: { sourcePrefixPreserved: true, outputSha256 }, validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'raw-jpeg-image-proof', 'artifact-sha256'], outputSha256 } });
    lifecycle.promotedArtifact = { artifact: await store.promotePdfArtifact(documentId, outputPath, { displayName: 'jpeg-image.pdf', operation, expectedSha256: outputSha256, signal: deadline.signal }) };
    if (!lifecycle.promotedArtifact.artifact || lifecycle.promotedArtifact.artifact.sha256 !== outputSha256 || lifecycle.promotedArtifact.artifact.id === source.id) fail('PDF_JPEG_IMAGE_OUTPUT_INVALID', 'The promoted JPEG image artifact did not match the validated output.');
    abort(deadline.signal);
    lifecycle.completed = true;
    return Object.freeze({ kind: 'pdf-jpeg-image', sourceDigest: source.sha256, artifact: lifecycle.promotedArtifact.artifact, image: proof.image, page: proof.page, rect: proof.rect, evidence: Object.freeze({ sourcePrefixPreserved: true, outputDigestBound: true, sourceUnchanged: true, localOnly: true }), limitations: Object.freeze(['One baseline grayscale or RGB JPEG is inserted into one direct CropBox-contained page placement.', 'Only flat direct page trees and direct resource dictionaries are supported; historical source bytes remain in the append-only revision.']) });
  } catch (error) { writtenBytes?.fill(0); lifecycle.sourceBytes?.fill(0); lifecycle.outputBytes?.fill(0); throw error; }
}
