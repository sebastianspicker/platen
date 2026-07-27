import { exactPositionals, fail, positiveInteger } from './parser-foundation.mjs';

const PREPRESS_OPERATIONS = new Set([
  'preflight',
  'ink-coverage',
  'separations',
  'overprint-preview',
  'icc-convert',
  'imposition',
  'production-validation',
]);

function parsePreflight(command, input, output, values) {
  const profile = values.get('profile') ?? 'print-review';
  const format = values.get('format') ?? 'json';
  if (!['print-review', 'archive-review'].includes(profile)) {
    fail('CLI_INVALID_OPTION', '--profile must be print-review or archive-review.');
  }
  if (!['json', 'xml'].includes(format)) {
    fail('CLI_INVALID_OPTION', '--format must be json or xml for preflight.');
  }
  if (values.has('page') || values.has('dpi') || values.has('layout')) {
    fail(
      'CLI_INVALID_OPTION',
      'preflight accepts only --profile, --format, and an optional --output.',
    );
  }
  return Object.freeze({ command, input, output, operation: 'preflight', profile, format });
}

function parseProductionValidation(command, input, output, values) {
  if (
    values.has('profile')
    || values.has('layout')
    || values.has('page')
    || values.has('dpi')
  ) {
    fail(
      'CLI_INVALID_OPTION',
      'production-validation accepts only an optional JSON --output.',
    );
  }
  return Object.freeze({ command, input, output, operation: 'production-validation' });
}

function parseIccConvert(command, input, output, values) {
  if (!output) {
    fail('CLI_INVALID_OPTION', 'icc-convert requires --output for the derived PDF.');
  }
  if (
    values.has('profile')
    || values.has('layout')
    || values.has('page')
    || values.has('dpi')
  ) {
    fail(
      'CLI_INVALID_OPTION',
      'icc-convert uses the fixed installed Ghostscript CMYK profile and accepts no tuning options.',
    );
  }
  return Object.freeze({ command, input, output, operation: 'icc-convert' });
}

function parseImposition(command, input, output, values) {
  if (!output) {
    fail('CLI_INVALID_OPTION', 'imposition requires --output for the derived PDF.');
  }
  if (values.has('profile') || values.has('page') || values.has('dpi')) {
    fail('CLI_INVALID_OPTION', 'imposition accepts only --layout and --output.');
  }
  const layout = values.get('layout') ?? '2x1';
  if (!['2x1', '2x2'].includes(layout)) {
    fail('CLI_INVALID_OPTION', '--layout must be 2x1 or 2x2.');
  }
  return Object.freeze({ command, input, output, operation: 'imposition', layout });
}

function parsePrepressPreview(command, input, output, operation, values) {
  if (values.has('profile')) {
    fail('CLI_INVALID_OPTION', '--profile is valid only for preflight.');
  }
  if (values.has('layout')) {
    fail('CLI_INVALID_OPTION', '--layout is valid only for imposition.');
  }
  const page = values.has('page')
    ? positiveInteger(values.get('page'), '--page', 10_000)
    : 1;
  const dpi = values.has('dpi')
    ? positiveInteger(values.get('dpi'), '--dpi', 300)
    : 144;
  if (dpi < 36) {
    fail('CLI_INVALID_OPTION', '--dpi must be from 36 through 300.');
  }
  if (operation === 'ink-coverage' && (values.has('page') || values.has('dpi'))) {
    fail('CLI_INVALID_OPTION', 'ink-coverage does not accept --page or --dpi.');
  }
  return Object.freeze({ command, input, output, operation, page, dpi });
}

export function parsePrepress(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  const operation = values.get('operation');
  if (!PREPRESS_OPERATIONS.has(operation)) {
    fail(
      'CLI_INVALID_OPTION',
      '--operation must be preflight, ink-coverage, separations, overprint-preview, icc-convert, imposition, or production-validation.',
    );
  }
  if (operation !== 'preflight' && values.has('format')) {
    fail('CLI_INVALID_OPTION', '--format is valid only for preflight.');
  }
  if (operation === 'preflight') {
    return parsePreflight(command, input, output, values);
  }
  if (operation === 'production-validation') {
    return parseProductionValidation(command, input, output, values);
  }
  if (operation === 'icc-convert') {
    return parseIccConvert(command, input, output, values);
  }
  if (operation === 'imposition') {
    return parseImposition(command, input, output, values);
  }
  return parsePrepressPreview(command, input, output, operation, values);
}
