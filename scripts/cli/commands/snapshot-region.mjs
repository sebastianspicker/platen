import { PNG_SIGNATURE } from '../../host/pdf-service-limits.mjs';
import { MAX_SNAPSHOT_BLOB_BYTES } from '../../../src/core/snapshot-output.js';

export async function runSnapshotRegionCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const service = application.service;
  if (!service || typeof service.renderCropBoxSnapshot !== 'function') {
    runtime.fail('CLI_SNAPSHOT_REGION_UNAVAILABLE', 'Selected-region export is unavailable.');
  }
  let png = null;
  try {
    png = await service.renderCropBoxSnapshot(document.id, {
      page: command.page,
      dpi: command.dpi,
      region: command.region,
      signal,
    });
    runtime.cancelled(signal);
    if (!Buffer.isBuffer(png) || png.length < PNG_SIGNATURE.length || png.length > MAX_SNAPSHOT_BLOB_BYTES
      || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      runtime.fail('CLI_INVALID_ENGINE_OUTPUT', 'Selected-region export did not return a bounded PNG payload.');
    }
    await runtime.writeExclusive(command.output, png, signal);
    await runtime.emit(stdout, {
      kind: 'cropbox-snapshot',
      sourceSha256: document.sha256,
      page: command.page,
      dpi: command.dpi,
      region: command.region,
      bytes: png.length,
      localOnly: true,
    });
  } finally {
    if (Buffer.isBuffer(png)) png.fill(0);
  }
}
