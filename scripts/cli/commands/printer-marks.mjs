import { basename } from 'node:path';
import { PDF_PRINTER_MARKS_PROFILE } from '../../host/pdf-printer-marks-contract.mjs';

export async function runPrinterMarksCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const service = application.printerMarks;
  if (!service || typeof service.create !== 'function') runtime.fail('CLI_PRINTER_MARKS_UNAVAILABLE', 'Printer marks are unavailable.');
  let result = null;
  try {
    result = await service.create(document.id, { profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256: document.sha256, pages: command.pages }, { sourceSha256: document.sha256, signal });
    runtime.cancelled(signal);
    const artifact = application.store.getArtifact(result.artifact.id);
    await runtime.copyExclusive(artifact.filePath, command.output);
    await runtime.emit(stdout, { ...result, artifact: { ...result.artifact, output: basename(command.output) }, localOnly: true });
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED' && result?.artifact?.id) await application.store.deleteArtifact(result.artifact.id).catch(() => {});
    throw error;
  }
}
