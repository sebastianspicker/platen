import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open, readFile, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { HostError } from './host-error.mjs';
import { createDeadline } from './pdf-service-foundation.mjs';
import { createOperationProvenance } from './operation-provenance.mjs';
import { stagePrivateSourceCopy, assertPrivateSourceCopy } from './private-source-copy.mjs';
import {
  PDF_FILE_AUDIO_ATTACHMENT_PROFILE,
  normalizePdfFileAudioAttachment,
} from './pdf-file-audio-attachment-contract.mjs';
import {
  inspectPdfFileAudioAttachment,
  writePdfFileAudioAttachment,
} from './pdf-file-audio-attachment-writer.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_JOB_MS = 120_000;
const STORE_METHODS = Object.freeze([
  'getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace',
  'cleanupJob', 'promotePdfArtifact', 'deleteArtifact',
]);
const INPUT_METHODS = Object.freeze(['getInput', 'getSourcePath', 'verifyInput']);

function host(code, message, status = 502, cause) { return new HostError(code, message, status, cause ? { cause } : undefined); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function overlap(left, right) { return left.buffer === right.buffer && left.byteOffset < right.byteOffset + right.byteLength && right.byteOffset < left.byteOffset + left.byteLength; }
function cancelled(signal) { if (signal?.aborted) throw host('JOB_CANCELLED', 'File/audio attachment processing was cancelled.', 499); }

async function readStableAsset(inputs, request, signal) {
  cancelled(signal);
  let record;
  try { record = inputs.getInput(request.assetId); } catch (error) { throw host('PDF_FILE_AUDIO_ATTACHMENT_INPUT_NOT_FOUND', 'The trusted input asset was not found.', 404, error); }
  if (record.sha256 !== request.assetSha256 || record.mediaType !== request.mediaType || record.extension !== request.extension
    || !SHA256.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 1 || record.size > MAX_ASSET_BYTES) {
    throw host('PDF_FILE_AUDIO_ATTACHMENT_INPUT_MISMATCH', 'The trusted input asset record does not match the requested digest, media type, or extension.', 409);
  }
  try { await inputs.verifyInput(request.assetId); } catch (error) { throw host('PDF_FILE_AUDIO_ATTACHMENT_INPUT_TAMPERED', 'The trusted input asset failed its integrity check.', 409, error); }
  const path = inputs.getSourcePath(request.assetId); let handle = null; let bytes = null; let retained = false;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n || before.size !== BigInt(record.size)) throw host('PDF_FILE_AUDIO_ATTACHMENT_INPUT_TAMPERED', 'The trusted input asset is not a private regular file.', 409);
    bytes = Buffer.alloc(record.size); let offset = 0;
    while (offset < bytes.length) { cancelled(signal); const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) throw host('PDF_FILE_AUDIO_ATTACHMENT_INPUT_TAMPERED', 'The trusted input asset ended while being read.', 409); offset += bytesRead; }
    const extra = Buffer.alloc(1); if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) throw host('PDF_FILE_AUDIO_ATTACHMENT_INPUT_TAMPERED', 'The trusted input asset grew while being read.', 409);
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1n || after.size !== before.size || (after.mode & 0o777n) !== 0o600n || digest(bytes) !== record.sha256) throw host('PDF_FILE_AUDIO_ATTACHMENT_INPUT_TAMPERED', 'The trusted input asset changed while being read.', 409);
    await inputs.verifyInput(request.assetId);
    const displayName = record.displayName;
    if (typeof displayName !== 'string' || !/^[\x20-\x7e]{1,240}$/u.test(displayName) || basename(displayName) !== displayName || extname(displayName).toLowerCase() !== request.extension) throw host('PDF_FILE_AUDIO_ATTACHMENT_INPUT_UNSUPPORTED', 'The trusted input asset has no safe display name for PDF embedding.', 415);
    retained = true;
    return Object.freeze({ bytes, displayName, mediaType: record.mediaType, extension: record.extension, sha256: record.sha256 });
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw host('PDF_FILE_AUDIO_ATTACHMENT_INPUT_READ_FAILED', 'The trusted input asset could not be read safely.', 500, error);
  } finally { await handle?.close().catch(() => {}); if (!retained) bytes?.fill(0); }
}

async function workspaceShape(workspace, expected) {
  const { readdir } = await import('node:fs/promises');
  const entries = (await readdir(workspace)).sort(); if (entries.join('\0') !== [...expected].sort().join('\0')) throw host('PDF_FILE_AUDIO_ATTACHMENT_WORKSPACE_INVALID', 'Attachment processing produced an unexpected private workspace.', 502);
  for (const entry of entries) { const stat = await lstat(join(workspace, entry)); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw host('PDF_FILE_AUDIO_ATTACHMENT_WORKSPACE_INVALID', 'Attachment processing produced an unsafe private workspace file.', 502); }
}
async function writeOutput(path, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 64 || bytes.length > MAX_SOURCE_BYTES + MAX_ASSET_BYTES + 1_048_576) throw host('PDF_FILE_AUDIO_ATTACHMENT_OUTPUT_INVALID', 'The raw attachment writer returned an invalid output.', 502);
  const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await chmod(path, 0o400);
}
async function cleanup(store, workspaces, promoted, completed) {
  const results = await Promise.allSettled(workspaces.reverse().map((path) => store.cleanupJob(path))); const workspaceFailed = results.some(({ status }) => status === 'rejected'); let artifactFailed = false;
  if ((!completed || workspaceFailed) && promoted?.artifact?.id) { try { await store.deleteArtifact(promoted.artifact.id); } catch { artifactFailed = true; } }
  if (workspaceFailed || artifactFailed) throw host('PDF_FILE_AUDIO_ATTACHMENT_CLEANUP_FAILED', 'File/audio attachment processing could not clean its private workspace or artifact.', 500);
}

export class PdfFileAudioAttachmentService {
  #store; #inputs;
  constructor({ store, inputs } = {}) {
    if (!store || STORE_METHODS.some((name) => typeof store[name] !== 'function') || !inputs || INPUT_METHODS.some((name) => typeof inputs[name] !== 'function')) throw new TypeError('PdfFileAudioAttachmentService requires document and trusted input stores.');
    this.#store = store; this.#inputs = inputs;
  }

  async add(documentId, value, { sourceSha256, signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    let request; try { request = normalizePdfFileAudioAttachment(value); } catch (error) { throw host('INVALID_PDF_FILE_AUDIO_ATTACHMENT_OPTIONS', 'The file/audio attachment request is invalid.', 400, error); }
    const source = this.#store.getDocument(documentId); if (!SHA256.test(String(sourceSha256 ?? '')) || sourceSha256 !== source.sha256 || request.sourceSha256 !== source.sha256) throw host('SOURCE_VERSION_MISMATCH', 'The file/audio attachment source digest does not match the current document.', 409);
    if (!Number.isSafeInteger(source.size) || source.size < 5 || source.size > MAX_SOURCE_BYTES) throw host('PDF_FILE_AUDIO_ATTACHMENT_INPUT_TOO_LARGE', 'File/audio attachment editing is limited to non-empty 128 MiB documents.', 413);
    const deadline = createDeadline(signal, MAX_JOB_MS); const workspaces = []; let sourceBytes = null; let assetBytes = null; let outputBytes = null; let promoted = null; let completed = false;
    try {
      cancelled(deadline.signal); await this.#store.verifySource(documentId);
      const workspace = await this.#store.createJobWorkspace(documentId); workspaces.push(workspace);
      const inputPath = join(workspace, 'input.pdf'); const outputPath = join(workspace, 'output.pdf'); const assetPath = join(workspace, 'asset.bin');
      const sourceIdentity = await stagePrivateSourceCopy({ sourcePath: this.#store.getSourcePath(documentId), targetPath: inputPath, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES, signal: deadline.signal });
      const verifiedAsset = await readStableAsset(this.#inputs, request, deadline.signal); assetBytes = verifiedAsset.bytes;
      await (async () => { const handle = await (await import('node:fs/promises')).open(assetPath, 'wx', 0o600); try { await handle.writeFile(assetBytes); await handle.sync(); } finally { await handle.close(); } await chmod(assetPath, 0o400); })();
      await workspaceShape(workspace, ['asset.bin', 'input.pdf']);
      sourceBytes = await readFile(inputPath); if (digest(sourceBytes) !== source.sha256) throw host('SOURCE_INTEGRITY_FAILED', 'The private source changed before attachment writing.', 500);
      const asset = { bytes: assetBytes, displayName: verifiedAsset.displayName, mediaType: verifiedAsset.mediaType, extension: verifiedAsset.extension, sha256: verifiedAsset.sha256 };
      const written = writePdfFileAudioAttachment(sourceBytes, request, asset); if (!written?.proof || !Buffer.isBuffer(written.bytes) || overlap(written.bytes, sourceBytes)) throw host('PDF_FILE_AUDIO_ATTACHMENT_OUTPUT_INVALID', 'The raw attachment writer returned an invalid result.', 502);
      await writeOutput(outputPath, written.bytes); written.bytes.fill(0);
      await workspaceShape(workspace, ['asset.bin', 'input.pdf', 'output.pdf']); outputBytes = await readFile(outputPath);
      const proof = inspectPdfFileAudioAttachment(sourceBytes, outputBytes, request, written); if (!proof || JSON.stringify(proof) !== JSON.stringify(written.proof)) throw host('PDF_FILE_AUDIO_ATTACHMENT_OUTPUT_INVALID', 'Independent attachment reinspection disagreed with the writer proof.', 502);
      await assertPrivateSourceCopy({ path: inputPath, identity: sourceIdentity, expectedSha256: source.sha256, expectedSize: source.size, maximumBytes: MAX_SOURCE_BYTES }); await this.#store.verifySource(documentId); await this.#inputs.verifyInput(request.assetId); cancelled(deadline.signal);
      const outputDigest = digest(outputBytes); if (outputDigest === source.sha256) throw host('PDF_FILE_AUDIO_ATTACHMENT_OUTPUT_INVALID', 'Attachment output did not produce a distinct artifact digest.', 502);
      const operation = createOperationProvenance({ type: 'pdf-file-audio-attachment', inputs: [{ documentId, sha256: source.sha256, role: 'source' }, { assetId: request.assetId, sha256: request.assetSha256, role: 'attachment' }], parameters: request, expected: { page: request.page, sourcePrefixPreserved: true, sourceUnchanged: true, annotationSubtype: 'FileAttachment', outputSha256: outputDigest }, validation: { passed: true, validators: ['source-sha256', 'input-asset-id-digest-media-type-extension', 'private-source-copy', 'raw-file-audio-attachment-proof', 'embedded-bytes-reinspection', 'annotation-reinspection', 'workspace-cleanup', 'artifact-sha256'], outputSha256: outputDigest } });
      const stem = basename(source.displayName, extname(source.displayName)); const artifact = await this.#store.promotePdfArtifact(documentId, outputPath, { displayName: `${stem}-attachment.pdf`, operation, expectedSha256: outputDigest, signal: deadline.signal }); promoted = { artifact }; if (!artifact || artifact.sha256 !== outputDigest || artifact.id === source.id) throw host('PDF_FILE_AUDIO_ATTACHMENT_OUTPUT_INVALID', 'Promoted attachment artifact did not match validated output.', 502);
      await this.#store.verifySource(documentId);
      await this.#inputs.verifyInput(request.assetId);
      cancelled(deadline.signal);
      completed = true;
      return Object.freeze({
        kind: 'pdf-file-audio-attachment',
        sourceDigest: source.sha256,
        artifact,
        attachment: Object.freeze({
          assetId: request.assetId,
          assetSha256: request.assetSha256,
          mediaType: request.mediaType,
          extension: request.extension,
          page: request.page,
          rect: request.rect,
        }),
        evidence: Object.freeze({
          sourceDigestReverified: true,
          inputAssetReverified: true,
          sourcePrefixPreserved: true,
          embeddedBytesReinspected: true,
          annotationReinspected: true,
          passiveFileAttachment: true,
          noActions: true,
          noRichMedia: true,
          noAutoplay: true,
          artifactDigestBound: true,
          sourceUnchanged: true,
          localOnly: true,
        }),
        limitations: Object.freeze([
          'One inert FileAttachment annotation is supported; this does not provide Sound actions, RichMedia, recording, microphone access, autoplay, or general annotation authoring.',
          'Only one bounded local .txt, .bin, or validated PCM .wav asset is accepted. Signatures, encryption, tags, forms, actions, layers, existing embedded files, prior revisions, and unsupported graphs fail closed.',
          'The source remains unchanged and historical source bytes remain as the exact prefix of the append-only artifact.',
        ]),
      });
    } catch (error) {
      if (deadline.timedOut) throw host('PDF_FILE_AUDIO_ATTACHMENT_TIMEOUT', 'File/audio attachment processing exceeded its two-minute deadline.', 504, error);
      if (signal?.aborted) throw host('JOB_CANCELLED', 'File/audio attachment processing was cancelled.', 499, error);
      if (error instanceof HostError) throw error;
      if (error?.code === 'INVALID_PDF_FILE_AUDIO_ATTACHMENT') throw host('PDF_FILE_AUDIO_ATTACHMENT_SOURCE_UNSUPPORTED', 'The PDF is outside the supported passive attachment subset.', 422, error);
      if (error?.code === 'INVALID_PDF_FILE_AUDIO_ATTACHMENT_OUTPUT') throw host('PDF_FILE_AUDIO_ATTACHMENT_OUTPUT_INVALID', 'The append-only attachment output failed separate reinspection.', 502, error);
      throw host('PDF_FILE_AUDIO_ATTACHMENT_FAILED', 'The local host could not create a verified file/audio attachment artifact.', 502, error);
    } finally { deadline.dispose(); sourceBytes?.fill(0); assetBytes?.fill(0); outputBytes?.fill(0); await cleanup(this.#store, workspaces, promoted, completed); }
  }
}

export function createPdfFileAudioAttachmentService(options) { return new PdfFileAudioAttachmentService(options); }
export const PdfFileAttachmentService = PdfFileAudioAttachmentService;
