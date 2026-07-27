const CLEANUP_PRESETS = new Set(['none', 'document', 'bilevel']);
const SEGMENTATION_MODES = new Set(['auto', 'single-column', 'block', 'sparse']);
const MAX_PATH_LENGTH = 4_096;

export const MAX_BATCH_FILES = 8;
export const MAX_WATCH_FILES = 64;

const COMMAND_OPTIONS = Object.freeze({
  engines: Object.freeze({ values: new Set(['output']), flags: new Set() }),
  inspect: Object.freeze({
    values: new Set(['output']),
    flags: new Set(['structure', 'tag-text']),
  }),
  'fast-web-view': Object.freeze({ values: new Set(['output']), flags: new Set() }),
  'accessibility-review': Object.freeze({ values: new Set(['output']), flags: new Set() }),
  'accessibility-metadata': Object.freeze({ values: new Set(['language', 'title', 'output']), flags: new Set() }),
  'signature-review': Object.freeze({ values: new Set(['output']), flags: new Set() }),
  'compare-content': Object.freeze({ values: new Set(['format', 'output']), flags: new Set() }),
  'create-blank': Object.freeze({ values: new Set(['pages', 'output']), flags: new Set() }),
  'professional-capability': Object.freeze({ values: new Set(['capability-id', 'output']), flags: new Set() }),
  'convert-local': Object.freeze({ values: new Set(['output']), flags: new Set() }),
  text: Object.freeze({ values: new Set(['format', 'output']), flags: new Set() }),
  'export-ooxml': Object.freeze({ values: new Set(['format', 'output']), flags: new Set() }),
  ocr: Object.freeze({
    values: new Set(['output', 'language', 'cleanup', 'segmentation']),
    flags: new Set(),
  }),
  'ocr-layout': Object.freeze({
    values: new Set([
      'page', 'region', 'format', 'output', 'language', 'cleanup', 'segmentation',
    ]),
    flags: new Set(['no-tables']),
  }),
  'ocr-batch': Object.freeze({
    values: new Set(['output-dir', 'language', 'cleanup', 'segmentation']),
    flags: new Set(),
  }),
  'watch-ocr': Object.freeze({
    values: new Set([
      'output-dir', 'language', 'cleanup', 'segmentation',
      'max-files', 'interval-ms', 'settle-ms',
    ]),
    flags: new Set(['once']),
  }),
  'automation-submit-inspect': Object.freeze({
    values: new Set(['automation-root', 'idempotency-key', 'output']), flags: new Set(),
  }),
  'automation-submit': Object.freeze({
    values: new Set([
      'automation-root', 'idempotency-key', 'operation', 'preset',
      'language', 'cleanup', 'segmentation', 'pages', 'output',
    ]), flags: new Set(),
  }),
  'automation-submit-ocr': Object.freeze({
    values: new Set([
      'automation-root', 'idempotency-key', 'language', 'cleanup', 'segmentation', 'output',
    ]), flags: new Set(),
  }),
  'automation-submit-output-intent': Object.freeze({
    values: new Set(['automation-root', 'idempotency-key', 'output']), flags: new Set(),
  }),
  'automation-submit-full-page-redaction': Object.freeze({
    values: new Set(['automation-root', 'pages', 'idempotency-key', 'output']), flags: new Set(),
  }),
  'automation-submit-sequence': Object.freeze({
    values: new Set(['automation-root', 'sequence', 'idempotency-key', 'output']), flags: new Set(),
  }),
  'automation-run': Object.freeze({ values: new Set(['automation-root', 'output']), flags: new Set() }),
  'automation-status': Object.freeze({ values: new Set(['automation-root', 'output']), flags: new Set() }),
  'automation-cancel': Object.freeze({ values: new Set(['automation-root', 'output']), flags: new Set() }),
  'automation-output-list': Object.freeze({ values: new Set(['automation-root', 'output']), flags: new Set() }),
  'automation-output-copy': Object.freeze({ values: new Set(['automation-root', 'sha256', 'output']), flags: new Set() }),
  'automation-output-delete': Object.freeze({ values: new Set(['automation-root', 'sha256', 'output']), flags: new Set() }),
  'admin.plugin-allowlist': Object.freeze({ values: new Set(['action', 'trust-root', 'publisher-id', 'key-id', 'public-key', 'plugin-id', 'expected-fingerprint', 'output']), flags: new Set() }),
  'admin.plugin-package': Object.freeze({ values: new Set(['action', 'plugin-root', 'trust-root', 'package', 'plugin-id', 'version', 'output']), flags: new Set() }),
  prepress: Object.freeze({
    values: new Set(['operation', 'profile', 'format', 'layout', 'page', 'dpi', 'output']),
    flags: new Set(),
  }),
  'layer-defaults': Object.freeze({ values: new Set(['changes', 'output']), flags: new Set() }),
  'signing-identities': Object.freeze({ values: new Set(['output']), flags: new Set() }),
  'certificate-sign': Object.freeze({ values: new Set(['certificate-sha256', 'page', 'field-name', 'reason', 'location', 'contact', 'placeholder-bytes', 'output']), flags: new Set() }),
  'sanitize-hidden-data': Object.freeze({ values: new Set(['output']), flags: new Set() }),
  'add-checkbox': Object.freeze({ values: new Set(['field-name', 'page', 'rect', 'output']), flags: new Set() }),
  'add-radio-group': Object.freeze({ values: new Set(['group-name', 'options', 'output']), flags: new Set() }),
  'acroform-text-field': Object.freeze({ values: new Set(['field', 'page', 'rect', 'output']), flags: new Set() }),
  'acroform-signature-field': Object.freeze({ values: new Set(['field', 'page', 'rect', 'output']), flags: new Set() }),
  'aec-measurement-legend': Object.freeze({ values: new Set(['format', 'output']), flags: new Set() }),
  'aec-batch-link': Object.freeze({ values: new Set(['links', 'output']), flags: new Set() }),
  'acroform-choice': Object.freeze({ values: new Set(['field', 'page', 'rect', 'options', 'output']), flags: new Set() }),
  'bates-numbering': Object.freeze({ values: new Set(['pages', 'start', 'prefix', 'suffix', 'padding', 'position', 'margin', 'font-size', 'output']), flags: new Set() }),
  'page-transition': Object.freeze({ values: new Set(['pages', 'duration', 'output']), flags: new Set() }),
  'scanner-discovery': Object.freeze({ values: new Set(['output']), flags: new Set() }),
  'scan-append': Object.freeze({ values: new Set(['after-page', 'output']), flags: new Set() }),
  'tagged-remediation': Object.freeze({ values: new Set(['plan', 'output']), flags: new Set() }),
  'insert-jpeg': Object.freeze({ values: new Set(['page', 'rect', 'output']), flags: new Set() }),
  'replace-jpeg': Object.freeze({ values: new Set(['page', 'resource-name', 'output']), flags: new Set() }),
  'page-labels': Object.freeze({ values: new Set(['ranges', 'output']), flags: new Set() }),
  'advanced-search': Object.freeze({ values: new Set(['query', 'mode', 'context', 'max-results', 'output']), flags: new Set(['case-sensitive', 'whole-word']) }),
  'specialist-content': Object.freeze({ values: new Set(), flags: new Set() }),
  'redact-pages': Object.freeze({ values: new Set(['pages', 'output']), flags: new Set() }),
  'printer-marks': Object.freeze({ values: new Set(['pages', 'output']), flags: new Set() }),
  'page-background': Object.freeze({ values: new Set(['pages', 'color', 'output']), flags: new Set() }),
  'snapshot-region': Object.freeze({ values: new Set(['page', 'region', 'dpi', 'output']), flags: new Set() }),
});

export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function boundedPath(value, label) {
  const invalid = typeof value !== 'string'
    || !value
    || value.length > MAX_PATH_LENGTH
    || value.includes('\0');
  if (invalid) {
    fail(
      'CLI_INVALID_PATH',
      `${label} must be a non-empty local path within ${MAX_PATH_LENGTH} characters.`,
    );
  }
  return value;
}

export function positiveInteger(value, label, maximum) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? ''))) {
    fail('CLI_INVALID_OPTION', `${label} must be a positive integer.`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > maximum) {
    fail('CLI_INVALID_OPTION', `${label} must be from 1 through ${maximum}.`);
  }
  return result;
}

export function normalizedRegion(value) {
  const parts = String(value ?? '').split(',');
  const invalidParts = parts.length !== 4
    || parts.some((part) => !part.trim() || !Number.isFinite(Number(part)));
  if (invalidParts) {
    fail(
      'CLI_INVALID_OPTION',
      '--region must contain four comma-separated normalized numbers: X,Y,W,H.',
    );
  }
  const [x, y, width, height] = parts.map(Number);
  if (
    x < 0
    || y < 0
    || width <= 0
    || height <= 0
    || x + width > 1
    || y + height > 1
  ) {
    fail(
      'CLI_INVALID_OPTION',
      '--region must be a positive normalized rectangle fully inside the page.',
    );
  }
  return Object.freeze({ x, y, width, height });
}

export function parsedTokens(command, tokens) {
  const definition = COMMAND_OPTIONS[command];
  if (!definition) {
    fail('CLI_UNKNOWN_COMMAND', `Unknown command: ${command}.`);
  }
  const values = new Map();
  const flags = new Set();
  const positionals = [];
  let positionalOnly = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && token.startsWith('--')) {
      const name = token.slice(2);
      if (!name || values.has(name) || flags.has(name)) {
        fail('CLI_INVALID_OPTION', `Duplicate or empty option: ${token}.`);
      }
      if (definition.flags.has(name)) {
        flags.add(name);
        continue;
      }
      if (!definition.values.has(name)) {
        fail('CLI_INVALID_OPTION', `Option ${token} is not valid for ${command}.`);
      }
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('--')) {
        fail('CLI_INVALID_OPTION', `Option ${token} requires a value.`);
      }
      values.set(name, value);
      index += 1;
      continue;
    }
    positionals.push(token);
  }
  return { values, flags, positionals };
}

export function ocrOptions(values) {
  const language = values.get('language') ?? 'eng';
  const cleanupPreset = values.get('cleanup') ?? 'document';
  const segmentation = values.get('segmentation') ?? 'auto';
  if (!/^[A-Za-z0-9_+-]{1,128}$/u.test(language)) {
    fail('CLI_INVALID_OPTION', '--language contains unsupported characters.');
  }
  if (!CLEANUP_PRESETS.has(cleanupPreset)) {
    fail('CLI_INVALID_OPTION', '--cleanup must be none, document, or bilevel.');
  }
  if (!SEGMENTATION_MODES.has(segmentation)) {
    fail(
      'CLI_INVALID_OPTION',
      '--segmentation must be auto, single-column, block, or sparse.',
    );
  }
  return { language, cleanupPreset, segmentation };
}

export function exactPositionals(positionals, minimum, maximum = minimum) {
  if (positionals.length < minimum || positionals.length > maximum) {
    const expected = minimum === maximum
      ? `exactly ${minimum}`
      : `${minimum} through ${maximum}`;
    fail(
      'CLI_INVALID_ARGUMENTS',
      `This command requires ${expected} input path${maximum === 1 ? '' : 's'}.`,
    );
  }
  return positionals.map((value, index) => boundedPath(value, `Input ${index + 1}`));
}
