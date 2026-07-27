import { basename } from 'node:path';

export async function runFastWebViewCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  await runtime.canonicalOutputTarget(command.output);
  let result;
  try {
    result = await application.fastWebView.linearize(document.id, {
      profile: 'local-pdf-fast-web-view-v1',
    }, { sourceSha256: document.sha256, signal });
    runtime.cancelled(signal);
    const artifact = application.store.getArtifact(result.artifact.id);
    await runtime.copyExclusive(artifact.filePath, command.output, signal);
    runtime.cancelled(signal);
    await runtime.emit(stdout, {
      ...result,
      artifact: { ...result.artifact, output: basename(command.output) },
      localOnly: true,
    });
  } finally {
    if (result?.artifact?.id) await application.store.deleteArtifact(result.artifact.id).catch(() => {});
  }
}

