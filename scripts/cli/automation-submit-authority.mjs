import { types as nodeTypes } from 'node:util';
import { HostError } from '../host/host-error.mjs';
import {
  AUTOMATION_FULL_PAGE_REDACTION_TYPE, AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE, AUTOMATION_PRESET_IDS, OPAQUE_ID, SHA256,
} from '../host/automation/automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_IDS } from '../host/automation/automation-sequence-contract.mjs';

export const AUTOMATION_SUBMIT_CLI_PRINCIPAL = 'platen.cli.automation-submit';
export const AUTOMATION_SUBMIT_CLI_GRANT = Object.freeze({
  grantId: 'platen-cli-automation-submit-v1', principal: AUTOMATION_SUBMIT_CLI_PRINCIPAL,
});

const AUTHORITY_CODE = 'AUTOMATION_SUBMIT_CLI_AUTHORITY_DENIED';
const SINGLE_COMMANDS = new Set([
  'automation-submit', 'automation-submit-inspect', 'automation-submit-ocr',
  'automation-submit-output-intent', 'automation-submit-full-page-redaction',
  'automation-submit-sequence',
]);

function deny() {
  throw new HostError(AUTHORITY_CODE,
    'The automation submit CLI capability does not authorize this request.', 403);
}

function dataRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) return null;
  let descriptors; let actual;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    descriptors = Object.getOwnPropertyDescriptors(value); actual = Reflect.ownKeys(value);
  } catch { return null; }
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string'
    || !keys.includes(key) || !Object.hasOwn(descriptors, key)
    || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) return null;
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function dataArray(value) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  let descriptors; let keys;
  try { descriptors = Object.getOwnPropertyDescriptors(value); keys = Reflect.ownKeys(value); } catch { return null; }
  if (keys.length !== value.length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string'
    || !/^\d+$/u.test(key) || Number(key) >= value.length || !Object.hasOwn(descriptors, key)
    || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) return null;
  return Object.freeze(Array.from({ length: value.length }, (_, index) => descriptors[String(index)].value));
}

function sourceBinding(value) {
  const source = dataRecord(value, ['id', 'sha256']);
  return source && OPAQUE_ID.test(source.id ?? '') && SHA256.test(source.sha256 ?? '') ? source : null;
}

function commandSelection(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command) || nodeTypes.isProxy(command)
    || Object.getPrototypeOf(command) !== Object.prototype) return null;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(command); } catch { return null; }
  const name = descriptors.command;
  if (!name || !Object.hasOwn(name, 'value') || typeof name.value !== 'string'
    || !SINGLE_COMMANDS.has(name.value)) return null;
  const keys = ['automationRoot', 'command', 'idempotencyKey', 'input', 'output'];
  if (name.value === 'automation-submit') {
    const preset = descriptors.preset;
    const operation = descriptors.operation;
    if (Boolean(preset) === Boolean(operation) || (preset && !Object.hasOwn(preset, 'value'))
      || (operation && !Object.hasOwn(operation, 'value'))) return null;
    keys.push(preset ? 'preset' : 'operation');
    if (operation?.value === 'ocr') keys.push('cleanupPreset', 'language', 'segmentation');
    if (operation?.value === 'full-page-redaction') keys.push('pages');
  } else if (name.value === 'automation-submit-ocr') keys.push('cleanupPreset', 'language', 'segmentation');
  else if (name.value === 'automation-submit-full-page-redaction') keys.push('pages');
  else if (name.value === 'automation-submit-sequence') keys.push('sequence');
  const item = dataRecord(command, keys);
  if (!item) return null;
  const operationByCommand = {
    'automation-submit-inspect': AUTOMATION_INSPECT_TYPE,
    'automation-submit-ocr': AUTOMATION_OCR_TYPE,
    'automation-submit-output-intent': AUTOMATION_OUTPUT_INTENT_TYPE,
    'automation-submit-full-page-redaction': AUTOMATION_FULL_PAGE_REDACTION_TYPE,
  };
  const genericOperation = {
    inspect: AUTOMATION_INSPECT_TYPE, ocr: AUTOMATION_OCR_TYPE,
    'output-intent': AUTOMATION_OUTPUT_INTENT_TYPE,
    'full-page-redaction': AUTOMATION_FULL_PAGE_REDACTION_TYPE,
  };
  const operation = item.command === 'automation-submit'
    ? genericOperation[item.operation] : operationByCommand[item.command];
  if (item.command === 'automation-submit-sequence') {
    return AUTOMATION_SEQUENCE_IDS.includes(item.sequence) ? Object.freeze({ kind: 'sequence', id: item.sequence, pages: null }) : null;
  }
  if (item.command === 'automation-submit' && item.preset !== undefined) {
    return AUTOMATION_PRESET_IDS.includes(item.preset) ? Object.freeze({ kind: 'preset', id: item.preset, pages: null }) : null;
  }
  if (![AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_TYPE, AUTOMATION_OUTPUT_INTENT_TYPE,
    AUTOMATION_FULL_PAGE_REDACTION_TYPE].includes(operation)) return null;
  if (operation === AUTOMATION_OCR_TYPE && (item.language !== 'eng'
    || item.cleanupPreset !== 'document' || item.segmentation !== 'auto')) return null;
  const pages = operation === AUTOMATION_FULL_PAGE_REDACTION_TYPE ? dataArray(item.pages) : null;
  if (operation === AUTOMATION_FULL_PAGE_REDACTION_TYPE && (!pages || !pages.length)) return null;
  return Object.freeze({ kind: 'operation', id: operation, pages });
}

function selectionBinding(value, expected) {
  const selection = dataRecord(value, ['id', 'kind', 'pages']);
  if (!selection || selection.kind !== expected.kind || selection.id !== expected.id) return false;
  if (expected.pages === null) return selection.pages === null;
  const pages = dataArray(selection.pages);
  return Boolean(pages && pages.length === expected.pages.length
    && pages.every((page, index) => page === expected.pages[index]));
}

/** Creates a default-deny authority for one parsed automation-submit invocation. */
export function createAutomationSubmitCliAuthority(command) {
  const selection = commandSelection(command);
  if (selection === null) return null;
  let binding = null;
  return Object.freeze({
    requiresIdempotencyBinding: true,
    async authorize(grant, context) {
      const candidateGrant = dataRecord(grant, ['grantId', 'principal']);
      const item = dataRecord(context,
        ['action', 'capability', 'idempotencyKey', 'jobId', 'operation', 'outputId', 'principal', 'source']);
      if (!candidateGrant || candidateGrant.grantId !== AUTOMATION_SUBMIT_CLI_GRANT.grantId
        || candidateGrant.principal !== AUTOMATION_SUBMIT_CLI_PRINCIPAL || !item
        || item.principal !== AUTOMATION_SUBMIT_CLI_PRINCIPAL || item.capability !== 'automation.submit'
        || item.action !== 'submit' || item.jobId !== null || item.outputId !== null
        || typeof item.idempotencyKey !== 'string' || !item.idempotencyKey
        || !selectionBinding(item.operation, selection)) deny();
      const candidateSource = sourceBinding(item.source);
      if (!candidateSource || (binding && (binding.idempotencyKey !== item.idempotencyKey
        || binding.source.id !== candidateSource.id || binding.source.sha256 !== candidateSource.sha256))) deny();
      binding ??= Object.freeze({ idempotencyKey: item.idempotencyKey, source: candidateSource });
      return true;
    },
  });
}
