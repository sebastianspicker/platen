import { basename } from 'node:path';
import { FULL_PAGE_REDACTION_BATCH_PROFILE } from '../../host/pdf-full-page-redaction-writer.mjs';

export async function runFullPageRedactionBatchCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const service = application.fullPageRedaction;
  if (!service || typeof service.updateBatch !== 'function') runtime.fail('CLI_FULL_PAGE_REDACTION_UNAVAILABLE', 'Full-page redaction batch is unavailable.');
  const result = await service.updateBatch(document.id, {
    profile: FULL_PAGE_REDACTION_BATCH_PROFILE,
    sourceSha256: document.sha256,
    pages: command.pages,
  }, { sourceSha256: document.sha256, signal });
  runtime.cancelled(signal);
  const artifact = application.store.getArtifact(result.artifact.id);
  await runtime.copyExclusive(artifact.filePath, command.output);
  await runtime.emit(stdout, { ...result, artifact: { ...result.artifact, output: basename(command.output) }, localOnly: true });
}
