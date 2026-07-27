import { basename } from 'node:path';

function validLabel(value) {
  return typeof value === 'string'
    && value === value.normalize('NFC')
    && value.length >= 1
    && value.length <= 127
    && /^[\x20-\x7E]*$/u.test(value);
}

function cliError(message) {
  const error = new Error(message);
  error.code = 'CLI_INVALID_OPTION';
  return error;
}

function validateChoiceOptions(options) {
  const validShape = Array.isArray(options)
    && options.length >= 2
    && options.length <= 50
    && options.every((entry) => (
      entry
      && typeof entry === 'object'
      && Object.getPrototypeOf(entry) === Object.prototype
      && Reflect.ownKeys(entry).length === 1
      && Object.hasOwn(entry, 'label')
      && validLabel(entry.label)
    ));
  if (!validShape) {
    throw cliError('Choice options must contain two through fifty unique printable labels.');
  }
  if (new Set(options.map((entry) => entry.label)).size !== options.length) {
    throw cliError('Choice option labels must be unique.');
  }
  return options;
}

export async function runAcroFormChoiceCommand(
  application,
  command,
  document,
  stdout,
  signal,
  runtime,
) {
  const source = await runtime.readLocalInputBytes(command.optionsPath, {
    minimumBytes: 2,
    maximumBytes: 16 * 1024,
    extension: '.json',
    signal,
  });
  let options;
  try {
    options = JSON.parse(source.bytes.toString('utf8'));
  } catch {
    throw cliError('The choice options file is not valid JSON.');
  } finally {
    source.bytes.fill(0);
  }
  validateChoiceOptions(options);
  runtime.cancelled(signal);
  const result = await application.acroFormChoice.add(document.id, {
    profile: 'local-pdf-acroform-choice-v1',
    sourceSha256: document.sha256,
    page: command.page,
    fieldName: command.fieldName,
    rect: command.rect,
    options,
  }, { signal });
  runtime.cancelled(signal);
  const artifact = application.store.getArtifact(result.artifact.id);
  await runtime.copyExclusive(artifact.filePath, command.output, signal);
  await runtime.emit(stdout, {
    ...result,
    artifact: { ...result.artifact, output: basename(command.output) },
    localOnly: true,
    defaultSelection: null,
    combo: false,
  });
}
