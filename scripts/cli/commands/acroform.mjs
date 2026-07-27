import { basename } from 'node:path';

async function publish(application, command, document, request, stdout, signal, runtime) {
  const service = command.command === 'add-checkbox' ? application.acroFormCheckbox : command.command === 'add-radio-group' ? application.acroFormRadio : command.command === 'acroform-signature-field' ? application.acroFormSignatureField : application.acroFormTextField;
  const result = await service.add(document.id, { ...request, sourceSha256: document.sha256 }, { signal });
  try {
    runtime.cancelled(signal);
    const artifact = application.store.getArtifact(result.artifact.id);
    await runtime.copyExclusive(artifact.filePath, command.output, signal);
    runtime.cancelled(signal);
    await runtime.emit(stdout, { ...result, artifact: { ...result.artifact, output: basename(command.output) }, localOnly: true });
  } catch (error) {
    if (typeof application.store.deleteArtifact === 'function') await application.store.deleteArtifact(result.artifact.id).catch(() => {});
    throw error;
  }
}

export async function runAcroFormCheckboxCommand(application, command, document, stdout, signal, runtime) {
  return publish(application, command, document, { profile: 'local-pdf-acroform-checkbox-v1', page: command.page, fieldName: command.fieldName, rect: command.rect }, stdout, signal, runtime);
}

export async function runAcroFormRadioCommand(application, command, document, stdout, signal, runtime) {
  const source = await runtime.readLocalInputBytes(command.optionsPath, { minimumBytes: 2, maximumBytes: 16 * 1024, extension: '.json', signal });
  let options;
  try { options = JSON.parse(source.bytes.toString('utf8')); } catch { const error = new Error('The radio options file is not valid JSON.'); error.code = 'CLI_INVALID_OPTION'; throw error; } finally { source.bytes.fill(0); }
  if (!Array.isArray(options) || options.length < 2 || options.length > 10) { const error = new Error('Radio options must be an array of two through ten entries.'); error.code = 'CLI_INVALID_OPTION'; throw error; }
  return publish(application, command, document, { profile: 'local-pdf-acroform-radio-v1', groupName: command.groupName, options }, stdout, signal, runtime);
}

export async function runAcroFormTextFieldCommand(application, command, document, stdout, signal, runtime) {
  return publish(application, command, document, { profile: 'local-pdf-acroform-text-field-v1', page: command.page, fieldName: command.fieldName, rect: command.rect }, stdout, signal, runtime);
}

export async function runAcroFormSignatureFieldCommand(application, command, document, stdout, signal, runtime) {
  return publish(application, command, document, { profile: 'local-pdf-acroform-signature-field-v1', page: command.page, fieldName: command.fieldName, rect: command.rect }, stdout, signal, runtime);
}
