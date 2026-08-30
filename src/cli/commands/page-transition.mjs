import { basename } from 'node:path';
import { INCREMENTAL_PAGE_TRANSITION_PROFILE } from '../../contracts/pdf-incremental-page-transition-contract.js';

export async function runPageTransitionCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  let result = null;
  try {
    result = await application.incrementalPageTransition.update(document.id, {
      profile: INCREMENTAL_PAGE_TRANSITION_PROFILE,
      pages: command.pages,
      transition: 'Dissolve',
      duration: command.duration,
    }, { sourceSha256: document.sha256, signal });
    runtime.cancelled(signal);
    const artifact = application.cli.artifacts.get(result.artifact.id);
    await runtime.copyExclusive(artifact.filePath, command.output, signal);
    await runtime.emit(stdout, {
      profile: INCREMENTAL_PAGE_TRANSITION_PROFILE,
      ...result,
      artifact: { ...result.artifact, output: basename(command.output) },
      localOnly: true,
      sourceBound: true,
    });
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED' && result?.artifact?.id) await application.cli.artifacts.delete(result.artifact.id).catch(() => {});
    throw error;
  }
}
