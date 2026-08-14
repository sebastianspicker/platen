import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { PDF_JPEG_IMAGE_REPLACEMENT_PROFILE } from '../../host/pdf-jpeg-image-replacement-writer.mjs';

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function snapshotRecord(value, code, runtime, seen = new Set()) {
  try {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) runtime.fail(code, 'The replacement result contains cyclic data.');
    seen.add(value);
    if (Array.isArray(value)) return Object.freeze(value.map((entry) => snapshotRecord(entry, code, runtime, seen)));
    if (Object.getPrototypeOf(value) !== Object.prototype) runtime.fail(code, 'The replacement result is not a plain record.');
    const fields = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string') || Object.values(fields).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) runtime.fail(code, 'The replacement result contains accessors or symbols.');
    return Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, descriptor]) => [key, snapshotRecord(descriptor.value, code, runtime, seen)])));
  } catch (error) {
    if (error?.code === code) throw error;
    runtime.fail(code, 'The replacement result is not a safe data record.');
  } finally {
    if (value && typeof value === 'object') seen.delete(value);
  }
}

export async function runJpegImageReplacementCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal); if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const selected = await runtime.readLocalInputBytes(command.image, { minimumBytes: 12, maximumBytes: 16 * 1024 * 1024, signal }); const inputSha256 = createHash('sha256').update(selected.bytes).digest('hex'); let asset = null; let trustedAssetId = null; let trustedArtifactId = null; let copyCommitted = false;
  try {
    asset = await application.inputs.createInput({ stream: Readable.from([selected.bytes]), displayName: selected.displayName, mediaType: 'image/jpeg' }); if (!asset || !OPAQUE_ID.test(asset.id ?? '') || asset.mediaType !== 'image/jpeg' || !['.jpg', '.jpeg'].includes(asset.extension) || asset.size !== selected.bytes.length || asset.sha256 !== inputSha256) runtime.fail('CLI_INVALID_INPUT_RECORD', 'The private JPEG replacement input record is inconsistent.');
    await application.inputs.verifyInput(asset.id);
    if (typeof application.inputs.getInput === 'function') {
      const verified = application.inputs.getInput(asset.id);
      if (!verified || verified.id !== asset.id || verified.mediaType !== asset.mediaType || verified.extension !== asset.extension || verified.size !== asset.size || verified.sha256 !== asset.sha256) runtime.fail('CLI_INVALID_INPUT_RECORD', 'The private JPEG replacement input record changed during verification.');
    }
    trustedAssetId = asset.id; runtime.cancelled(signal); const replacement = application.jpegImageReplacementBroker ?? application.jpegImageReplacement; if (!replacement?.replace) runtime.fail('CLI_JPEG_IMAGE_REPLACEMENT_UNAVAILABLE', 'JPEG image replacement is unavailable.');
    const result = snapshotRecord(await replacement.replace(document.id, { profile: PDF_JPEG_IMAGE_REPLACEMENT_PROFILE, sourceSha256: document.sha256, inputId: asset.id, inputSha256: asset.sha256, page: command.page, resourceName: command.resourceName }, { signal }), 'CLI_INVALID_RESULT', runtime); const resultArtifact = snapshotRecord(result.artifact, 'CLI_INVALID_RESULT', runtime); if (!resultArtifact?.id || typeof resultArtifact.id !== 'string') runtime.fail('CLI_INVALID_RESULT', 'The replacement artifact result is invalid.'); const artifact = snapshotRecord(application.store.getArtifact(resultArtifact.id), 'CLI_INVALID_RESULT', runtime); if (!artifact?.filePath || artifact.id !== resultArtifact.id || artifact.sha256 !== resultArtifact.sha256) runtime.fail('CLI_INVALID_RESULT', 'The replacement artifact does not match the trusted store.');
    if (artifact.size !== resultArtifact.size || artifact.documentId !== document.id || artifact.mediaType !== 'application/pdf') runtime.fail('CLI_INVALID_RESULT', 'The replacement artifact does not match the trusted store.'); trustedArtifactId = resultArtifact.id; runtime.cancelled(signal);
    if (signal === undefined) await runtime.copyExclusive(artifact.filePath, command.output); else await runtime.copyExclusive(artifact.filePath, command.output, { signal }); copyCommitted = true;
    const receipt = {
      kind: result.kind,
      sourceDigest: result.sourceDigest,
      page: result.page,
      resourceName: result.resourceName,
      targetReference: result.targetReference,
      replacementImage: result.replacementImage,
      evidence: result.evidence,
      limitations: result.limitations,
      artifact: {
        id: resultArtifact.id,
        documentId: resultArtifact.documentId,
        mediaType: resultArtifact.mediaType,
        size: resultArtifact.size,
        sha256: resultArtifact.sha256,
        output: basename(command.output),
      },
      localOnly: true,
    };
    await runtime.emit(stdout, receipt);
  } finally {
    selected.bytes.fill(0);
    if (trustedArtifactId && typeof application.store.deleteArtifact === 'function') await application.store.deleteArtifact(trustedArtifactId).catch((error) => { if (!copyCommitted || error?.code !== 'ARTIFACT_NOT_FOUND') throw error; });
    if (trustedAssetId) await application.inputs.deleteInput(trustedAssetId);
  }
}
