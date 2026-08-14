import { basename } from 'node:path';
export async function runHiddenDataSanitizationCommand(application, command, document, stdout, signal, runtime) {
  const result = await application.hiddenDataSanitization.sanitize(document.id, { sourceSha256: document.sha256, signal });
  runtime.cancelled(signal);
  const artifact = application.store.getArtifact(result.artifact.id);
  await runtime.copyExclusive(artifact.filePath, command.output);
  await runtime.emit(stdout, { ...result, artifact: { ...result.artifact, output: basename(command.output) }, localOnly: true });
}
