import {
  boundedPath,
  exactPositionals,
  fail,
  ocrOptions,
  positiveInteger,
} from './parser-foundation.mjs';
import { AUTOMATION_PRESET_IDS } from '../host/automation/automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_IDS } from '../host/automation/automation-sequence-contract.mjs';

function automationRoot(values) {
  if (!values.has('automation-root')) fail('CLI_INVALID_OPTION', 'Automation commands require --automation-root.');
  return boundedPath(values.get('automation-root'), 'Automation root');
}

function automationJobId(value) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) fail('CLI_INVALID_OPTION', 'Automation job ID is invalid.');
  return value;
}

function automationOutputId(value) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) fail('CLI_INVALID_OPTION', 'Automation output ID is invalid.');
  return value;
}

function automationOutputDigest(values) {
  const digest = values.get('sha256');
  if (!/^[a-f0-9]{64}$/u.test(digest ?? '')) {
    fail('CLI_INVALID_OPTION', 'Automation output commands require an exact lowercase --sha256 digest.');
  }
  return digest;
}

function automationRedactionPages(value) {
  const terms = String(value ?? '').split(',');
  if (terms.length < 1 || terms.some((term) => term.length === 0)) {
    fail('CLI_INVALID_OPTION', '--pages requires a comma-separated page list.');
  }
  const pages = [];
  for (const term of terms) {
    const range = term.match(/^(\d+)(?:-(\d+))?$/u);
    if (!range) fail('CLI_INVALID_OPTION', '--pages must contain bounded positive page numbers or ranges.');
    const first = positiveInteger(range[1], '--pages', 100);
    const last = range[2] === undefined ? first : positiveInteger(range[2], '--pages', 100);
    if (last < first) fail('CLI_INVALID_OPTION', '--pages ranges must be ascending.');
    if (last - first + 1 > 100 || pages.length + last - first + 1 > 100) {
      fail('CLI_INVALID_OPTION', '--pages is limited to 100 unique pages.');
    }
    for (let page = first; page <= last; page += 1) pages.push(page);
  }
  const normalized = [...new Set(pages)].sort((left, right) => left - right);
  if (!normalized.length || normalized.length > 100) {
    fail('CLI_INVALID_OPTION', '--pages is limited to 100 unique pages.');
  }
  return Object.freeze(normalized);
}

export function parseAutomation(command, positionals, values, output) {
  const root = automationRoot(values);
  if (command === 'automation-submit-sequence') {
    const [input] = exactPositionals(positionals, 1); const sequence = values.get('sequence') ?? null;
    if (!AUTOMATION_SEQUENCE_IDS.includes(sequence)) fail('CLI_INVALID_OPTION', '--sequence must be an allowlisted automation sequence.');
    const idempotencyKey = values.get('idempotency-key') ?? null;
    if (idempotencyKey !== null && (!idempotencyKey || Buffer.byteLength(idempotencyKey) > 256)) fail('CLI_INVALID_OPTION', '--idempotency-key is invalid.');
    return Object.freeze({ command, input, automationRoot: root, sequence, idempotencyKey, output });
  }
  if (command === 'automation-submit') {
    const [input] = exactPositionals(positionals, 1);
    const operation = values.get('operation') ?? null;
    const preset = values.get('preset') ?? null;
    if ((operation === null) === (preset === null)) {
      fail('CLI_INVALID_OPTION', 'automation-submit requires exactly one of --operation or --preset.');
    }
    const idempotencyKey = values.get('idempotency-key') ?? null;
    if (idempotencyKey !== null && (!idempotencyKey || Buffer.byteLength(idempotencyKey) > 256)) {
      fail('CLI_INVALID_OPTION', '--idempotency-key must be a non-empty value no longer than 256 bytes.');
    }
    if (preset !== null) {
      if (!AUTOMATION_PRESET_IDS.includes(preset)) {
        fail('CLI_INVALID_OPTION', '--preset is not an allowlisted automation preset.');
      }
      if ([...values.keys()].some((key) => !['automation-root', 'idempotency-key', 'preset', 'output'].includes(key))) {
        fail('CLI_INVALID_OPTION', '--preset cannot be combined with operation parameters.');
      }
      return Object.freeze({ command, input, automationRoot: root, preset, idempotencyKey, output });
    }
    if (!['inspect', 'ocr', 'output-intent', 'full-page-redaction'].includes(operation)) {
      fail('CLI_INVALID_OPTION', '--operation must be inspect, ocr, output-intent, or full-page-redaction.');
    }
    if (operation === 'full-page-redaction' && !values.has('pages')) {
      fail('CLI_INVALID_OPTION', '--pages is required for full-page-redaction.');
    }
    if (operation !== 'full-page-redaction' && values.has('pages')) {
      fail('CLI_INVALID_OPTION', '--pages is valid only for full-page-redaction.');
    }
    if (operation !== 'ocr' && [...values.keys()].some((key) => ['language', 'cleanup', 'segmentation'].includes(key))) {
      fail('CLI_INVALID_OPTION', 'OCR options require --operation ocr.');
    }
    return Object.freeze({
      command, input, automationRoot: root, operation, idempotencyKey, output,
      ...(operation === 'full-page-redaction' ? { pages: automationRedactionPages(values.get('pages')) } : {}),
      ...(operation === 'ocr' ? ocrOptions(values) : {}),
    });
  }
  if (command === 'automation-submit-inspect' || command === 'automation-submit-ocr'
    || command === 'automation-submit-output-intent'
    || command === 'automation-submit-full-page-redaction') {
    const [input] = exactPositionals(positionals, 1);
    const idempotencyKey = values.get('idempotency-key') ?? null;
    if (idempotencyKey !== null && (!idempotencyKey || Buffer.byteLength(idempotencyKey) > 256)) {
      fail('CLI_INVALID_OPTION', '--idempotency-key must be a non-empty value no longer than 256 bytes.');
    }
    return Object.freeze({
      command,
      input,
      automationRoot: root,
      idempotencyKey,
      output,
      ...(command === 'automation-submit-full-page-redaction'
        ? { pages: automationRedactionPages(values.get('pages')) } : {}),
      ...(command === 'automation-submit-ocr' ? ocrOptions(values) : {}),
    });
  }
  if (command === 'automation-output-list') {
    exactPositionals(positionals, 0);
    return Object.freeze({ command, automationRoot: root, output });
  }
  if (command === 'automation-output-copy' || command === 'automation-output-delete') {
    const [outputId] = exactPositionals(positionals, 1);
    if (command === 'automation-output-copy' && !output) {
      fail('CLI_INVALID_OPTION', 'The automation-output-copy command requires --output.');
    }
    return Object.freeze({
      command,
      automationRoot: root,
      outputId: automationOutputId(outputId),
      sha256: automationOutputDigest(values),
      output,
    });
  }
  const [jobId] = command === 'automation-run' ? exactPositionals(positionals, 0) : exactPositionals(positionals, 1);
  return Object.freeze({ command, automationRoot: root, ...(jobId ? { jobId: automationJobId(jobId) } : {}), output });
}
