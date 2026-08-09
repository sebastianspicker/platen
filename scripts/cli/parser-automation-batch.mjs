import { boundedPath, exactPositionals, fail, ocrOptions } from './parser-foundation.mjs';
import { resolve } from 'node:path';
import { AUTOMATION_PRESET_IDS } from '../host/automation/automation-operation-contract.mjs';

const OPERATIONS = new Set(['inspect', 'ocr', 'output-intent', 'full-page-redaction']);
const MAX_BATCH_INPUTS = 8;
const COMMON_OPTIONS = Object.freeze(['automation-root', 'idempotency-key', 'operation', 'output']);

function usesOnly(values, allowed) {
  return [...values.keys()].every((key) => allowed.includes(key));
}

function batchIdentity(values) {
  const value = values.get('idempotency-key');
  const invalidText = typeof value !== 'string' || value.normalize('NFC') !== value
    || [...value].some((point) => /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(point));
  if (invalidText || !value || Buffer.byteLength(value) > 256) {
    fail('CLI_INVALID_OPTION', '--idempotency-key is required as bounded NFC text without control or private-use characters.');
  }
  return value;
}

function automationRoot(values) {
  if (!values.has('automation-root')) fail('CLI_INVALID_OPTION', 'Automation commands require --automation-root.');
  return boundedPath(values.get('automation-root'), 'Automation root');
}

function pageRange(term) {
  const range = term.match(/^(\d+)(?:-(\d+))?$/u);
  if (!range) fail('CLI_INVALID_OPTION', '--pages must contain bounded positive page numbers or ranges.');
  const first = Number(range[1]);
  const last = range[2] === undefined ? first : Number(range[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1
    || last < first || last > 100) {
    fail('CLI_INVALID_OPTION', '--pages must contain ascending page numbers from 1 through 100.');
  }
  return Object.freeze({ first, last });
}

function appendRange(pages, range) {
  const count = range.last - range.first + 1;
  if (count > 100 || pages.length + count > 100) {
    fail('CLI_INVALID_OPTION', '--pages is limited to 100 unique pages.');
  }
  for (let page = range.first; page <= range.last; page += 1) pages.push(page);
}

function redactionPages(value) {
  const terms = String(value ?? '').split(',');
  if (!terms.length || terms.some((term) => !term)) fail('CLI_INVALID_OPTION', '--pages requires a comma-separated page list.');
  const pages = [];
  for (const term of terms) appendRange(pages, pageRange(term));
  const normalized = [...new Set(pages)].sort((left, right) => left - right);
  if (!normalized.length || normalized.length > 100) fail('CLI_INVALID_OPTION', '--pages is limited to 100 unique pages.');
  return Object.freeze(normalized);
}

function batchInputs(positionals) {
  const inputs = exactPositionals(positionals, 2, MAX_BATCH_INPUTS);
  if (new Set(inputs.map((input) => resolve(input))).size !== inputs.length) fail('CLI_INVALID_OPTION', 'automation-submit-batch input paths must be distinct.');
  if (inputs.some((input) => !/\.pdf$/iu.test(input))) fail('CLI_INVALID_OPTION', 'automation-submit-batch accepts local PDF input paths only.');
  return Object.freeze(inputs);
}

function presetCommand(command, inputs, root, preset, idempotencyKey, values, output) {
  if (!AUTOMATION_PRESET_IDS.includes(preset)) {
    fail('CLI_INVALID_OPTION', '--preset is not an allowlisted automation preset.');
  }
  const allowed = ['automation-root', 'idempotency-key', 'preset', 'output'];
  if (!usesOnly(values, allowed)) {
    fail('CLI_INVALID_OPTION', '--preset cannot be combined with operation parameters.');
  }
  return Object.freeze({ command, inputs, automationRoot: root, preset, idempotencyKey, output });
}

function operationCommand(command, inputs, root, operation, idempotencyKey, values, output) {
  if (!OPERATIONS.has(operation)) {
    fail('CLI_INVALID_OPTION', '--operation must be inspect, ocr, output-intent, or full-page-redaction.');
  }
  const extraOptions = operation === 'ocr'
    ? ['language', 'cleanup', 'segmentation']
    : operation === 'full-page-redaction' ? ['pages'] : [];
  if (!usesOnly(values, [...COMMON_OPTIONS, ...extraOptions])) {
    fail('CLI_INVALID_OPTION', `Options are not valid for --operation ${operation}.`);
  }
  if (operation === 'full-page-redaction' && !values.has('pages')) {
    fail('CLI_INVALID_OPTION', '--pages is required for full-page-redaction.');
  }
  return Object.freeze({
    command, inputs, automationRoot: root, operation, idempotencyKey, output,
    ...(operation === 'full-page-redaction' ? { pages: redactionPages(values.get('pages')) } : {}),
    ...(operation === 'ocr' ? ocrOptions(values) : {}),
  });
}

export function parseAutomationCliBatch(command, positionals, values, output) {
  if (command !== 'automation-submit-batch') return null;
  const root = automationRoot(values);
  const inputs = batchInputs(positionals);
  const operation = values.get('operation') ?? null;
  const preset = values.get('preset') ?? null;
  if ((operation === null) === (preset === null)) fail('CLI_INVALID_OPTION', 'automation-submit-batch requires exactly one of --operation or --preset.');
  const idempotencyKey = batchIdentity(values);
  return preset !== null
    ? presetCommand(command, inputs, root, preset, idempotencyKey, values, output)
    : operationCommand(command, inputs, root, operation, idempotencyKey, values, output);
}
