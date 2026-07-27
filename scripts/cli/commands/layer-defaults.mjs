import { basename } from 'node:path';
import { PDF_LAYER_DEFAULTS_PROFILE } from '../../host/pdf-layer-defaults-contract.mjs';

export async function runLayerDefaultsCommand(application, command, document, stdout, signal, runtime) {
  const { copyExclusive, emit, cancelled } = runtime;
  const result = await application.layerDefaults.update(
    document.id,
    { profile: PDF_LAYER_DEFAULTS_PROFILE, sourceSha256: document.sha256, changes: command.changes },
    { sourceSha256: document.sha256, signal },
  );
  cancelled(signal);
  const artifact = application.store.getArtifact(result.artifact.id);
  await copyExclusive(artifact.filePath, command.output);
  await emit(stdout, {
    ...result,
    artifact: { ...result.artifact, output: basename(command.output) },
    localOnly: true,
  });
}
