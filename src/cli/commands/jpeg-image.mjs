import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { PDF_JPEG_IMAGE_PROFILE } from '../../contracts/public-wire-identifiers.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;

export async function runJpegImageCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const selected = await runtime.readLocalInputBytes(command.image, { minimumBytes: 12, maximumBytes: 16 * 1024 * 1024, signal });
  const inputSha256 = createHash('sha256').update(selected.bytes).digest('hex');
  let asset = null;
  try {
    asset = await application.cli.inputs.create({ stream: Readable.from([selected.bytes]), displayName: selected.displayName, mediaType: 'image/jpeg' });
    if (!asset || asset.mediaType !== 'image/jpeg' || !['.jpg', '.jpeg'].includes(asset.extension) || asset.size !== selected.bytes.length || !SHA256.test(asset.sha256) || asset.sha256 !== inputSha256) runtime.fail('CLI_INVALID_INPUT_RECORD', 'The private JPEG input record is inconsistent.');
    await application.cli.inputs.verify(asset.id);
    runtime.cancelled(signal);
    const insertion = application.jpegImageInsertion ?? application.jpegImageBroker;
    if (!insertion?.insert) runtime.fail('CLI_JPEG_IMAGE_UNAVAILABLE', 'JPEG image insertion is unavailable.');
    const result = await insertion.insert(document.id, { profile: PDF_JPEG_IMAGE_PROFILE, sourceSha256: document.sha256, inputId: asset.id, inputSha256: asset.sha256, page: command.page, rect: command.rect }, { signal });
    runtime.cancelled(signal);
    const artifact = application.cli.artifacts.get(result.artifact.id);
    await runtime.copyExclusive(artifact.filePath, command.output);
    await runtime.emit(stdout, { ...result, artifact: { ...result.artifact, output: basename(command.output) }, localOnly: true });
  } finally {
    selected.bytes.fill(0);
    if (asset?.id) await application.cli.inputs.delete(asset.id).catch((error) => { throw error; });
  }
}
