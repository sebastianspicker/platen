import { PDF_SPECIALIST_CONTENT_PROFILE } from '../../host/pdf-specialist-content-contract.mjs';

export async function runSpecialistContentCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal);
  const result = await application.specialistContent.inspect(document.id, { profile: PDF_SPECIALIST_CONTENT_PROFILE, sourceSha256: document.sha256 }, { sourceSha256: document.sha256, signal });
  runtime.cancelled(signal);
  await runtime.emit(stdout, result);
}
