import { basename } from 'node:path';
import { PDF_PAGE_BACKGROUND_PROFILE } from '../../host/pdf-page-background-contract.mjs';

export async function runPageBackgroundCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal); if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const service = application.pageBackground; if (!service || typeof service.create !== 'function') runtime.fail('CLI_PAGE_BACKGROUND_UNAVAILABLE', 'Page background is unavailable.');
  let result = null;
  try { result = await service.create(document.id, { profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: document.sha256, pages: command.pages, color: command.color }, { sourceSha256: document.sha256, signal }); runtime.cancelled(signal); const artifact = application.store.getArtifact(result.artifact.id); await runtime.copyExclusive(artifact.filePath, command.output, signal); runtime.cancelled(signal); await runtime.emit(stdout, { ...result, artifact: { ...result.artifact, output: basename(command.output) }, localOnly: true }); }
  catch (error) { if (result?.artifact?.id) await application.store.deleteArtifact(result.artifact.id).catch(() => {}); throw error; }
}
