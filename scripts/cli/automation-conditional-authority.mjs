import { types as nodeTypes } from 'node:util';
import { HostError } from '../host/host-error.mjs';
import {
  normalizeAutomationApiSubmitRequest,
} from '../host/automation/automation-api-contract.mjs';
import { OPAQUE_ID, SHA256 } from '../host/automation/automation-operation-contract.mjs';

/** The sole principal used by the invocation-scoped conditional CLI capability. */
export const AUTOMATION_CONDITIONAL_CLI_PRINCIPAL = 'platen.cli.automation-conditional';

/** The sole grant accepted by the invocation-scoped conditional CLI capability. */
export const AUTOMATION_CONDITIONAL_CLI_GRANT = Object.freeze({
  grantId: 'platen-cli-automation-conditional-v1',
  principal: AUTOMATION_CONDITIONAL_CLI_PRINCIPAL,
});

const AUTHORITY_CODE = 'AUTOMATION_CONDITIONAL_CLI_AUTHORITY_DENIED';
const EXECUTION_ID = /^cw_[a-f0-9]{32}$/u;
const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const VALID_CONDITIONAL_ACTIONS = new Set([
  'conditional.execute', 'conditional.submit', 'conditional.cancel', 'conditional.release',
]);
const PLACEHOLDER_PRINCIPAL = 'conditional-cli-validation';
const PLACEHOLDER_GRANT = Object.freeze({
  grantId: 'conditional-cli-validation-v1',
  principal: PLACEHOLDER_PRINCIPAL,
});
const PLACEHOLDER_SOURCE = Object.freeze({ id: 'conditional-cli-source', sha256: 'a'.repeat(64) });

function deny() {
  throw new HostError(
    AUTHORITY_CODE,
    'The automation conditional CLI capability does not authorize this request.',
    403,
  );
}

/*
 * Read only descriptor-backed records. The proxy check occurs before any
 * operation which could invoke a proxy trap; descriptor values are used so
 * accessors are rejected without invoking them.
 */
function dataRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || nodeTypes.isProxy(value)) return null;
  let descriptors;
  let ownKeys;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (ownKeys.length !== keys.length || ownKeys.some((key) => (
    typeof key !== 'string' || !keys.includes(key)
      || !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value')
      || descriptors[key].enumerable !== true
  ))) return null;
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function dataArray(value) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) return null;
  let descriptors;
  let ownKeys;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => (
    key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key)
      || Number(key) >= value.length || !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
  ))) return null;
  return Object.freeze(Array.from({ length: value.length }, (_, index) => descriptors[String(index)].value));
}

function sourceBinding(value) {
  const source = dataRecord(value, ['id', 'sha256']);
  if (!source || !OPAQUE_ID.test(source.id ?? '') || !SHA256.test(source.sha256 ?? '')) return null;
  return source;
}

function operationBinding(value) {
  if (value === null) return null;
  let normalized;
  try {
    normalized = normalizeAutomationApiSubmitRequest({
      principal: PLACEHOLDER_PRINCIPAL,
      grant: PLACEHOLDER_GRANT,
      source: PLACEHOLDER_SOURCE,
      operation: value,
      idempotencyKey: 'conditional-cli-validation',
    }).operation;
  } catch {
    return null;
  }
  const candidate = dataRecord(value, ['id', 'kind', 'pages']);
  if (!candidate || candidate.kind !== normalized.kind || candidate.id !== normalized.id) return null;
  if (normalized.pages === null) return candidate.pages === null ? normalized : null;
  const pages = dataArray(candidate.pages);
  if (!pages || pages.length !== normalized.pages.length
    || pages.some((page, index) => page !== normalized.pages[index])) return null;
  return normalized;
}

function sameSource(left, right) {
  return Boolean(left && right && left.id === right.id && left.sha256 === right.sha256);
}

function commandBinding(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)
    || nodeTypes.isProxy(command)) deny();
  let descriptors;
  try {
    if (Object.getPrototypeOf(command) !== Object.prototype) deny();
    descriptors = Object.getOwnPropertyDescriptors(command);
  } catch {
    deny();
  }
  const commandName = descriptors?.command;
  if (!commandName || !Object.hasOwn(commandName, 'value') || commandName.enumerable !== true) deny();
  if (commandName.value !== 'automation-run-conditional') return null;
  return true;
}

function contextRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) deny();
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) deny();
  } catch {
    deny();
  }
  const item = dataRecord(value, keys);
  if (!item) deny();
  return item;
}

function checkGrant(grant) {
  const candidate = dataRecord(grant, ['grantId', 'principal']);
  if (!candidate || candidate.grantId !== AUTOMATION_CONDITIONAL_CLI_GRANT.grantId
    || candidate.principal !== AUTOMATION_CONDITIONAL_CLI_PRINCIPAL) deny();
}

/**
 * Create the authority used by one `automation-run-conditional` invocation.
 * Source, execution, and workflow bindings are learned at execute and then
 * remain fixed for the life of this local invocation. No caller principal or
 * grant is accepted; both are fixed above.
 */
export function createAutomationConditionalCliAuthority(command) {
  if (commandBinding(command) === null) return null;
  let bound = null;
  return Object.freeze({
    async authorize(grant, context) {
      checkGrant(grant);
      const capabilityDescriptor = context && typeof context === 'object' && !Array.isArray(context)
        && !nodeTypes.isProxy(context)
        ? (() => {
          try {
            if (Object.getPrototypeOf(context) !== Object.prototype) return null;
            return Object.getOwnPropertyDescriptor(context, 'capability');
          } catch { return null; }
        })() : null;
      if (!capabilityDescriptor || !Object.hasOwn(capabilityDescriptor, 'value')
        || capabilityDescriptor.enumerable !== true) deny();

      if (capabilityDescriptor.value === 'automation.conditional') {
        const item = contextRecord(context,
          ['action', 'capability', 'executionId', 'operation', 'principal', 'source', 'workflowId']);
        if (item.principal !== AUTOMATION_CONDITIONAL_CLI_PRINCIPAL
          || !VALID_CONDITIONAL_ACTIONS.has(item.action)
          || !EXECUTION_ID.test(item.executionId ?? '')
          || !WORKFLOW_ID.test(item.workflowId ?? '')) deny();
        const source = sourceBinding(item.source);
        if (!source) deny();
        if (item.action !== 'conditional.submit' && item.operation !== null) deny();
        if (item.action === 'conditional.submit' && !operationBinding(item.operation)) deny();

        if (item.action === 'conditional.execute') {
          if (bound && (bound.executionId !== item.executionId || bound.workflowId !== item.workflowId
            || !sameSource(bound.source, source))) deny();
          bound ??= Object.freeze({ executionId: item.executionId, workflowId: item.workflowId, source });
        } else {
          if (!bound || bound.executionId !== item.executionId || bound.workflowId !== item.workflowId
            || !sameSource(bound.source, source)) deny();
        }
        return true;
      }

      if (capabilityDescriptor.value === 'automation.submit') {
        const item = contextRecord(context,
          ['action', 'capability', 'jobId', 'operation', 'outputId', 'principal', 'source']);
        if (!bound || item.principal !== AUTOMATION_CONDITIONAL_CLI_PRINCIPAL
          || item.action !== 'submit' || item.jobId !== null || item.outputId !== null
          || !sameSource(bound.source, sourceBinding(item.source))
          || !operationBinding(item.operation)) deny();
        return true;
      }

      if (capabilityDescriptor.value === 'automation.cancel') {
        const item = contextRecord(context,
          ['action', 'capability', 'jobId', 'operation', 'outputId', 'principal', 'source']);
        if (!bound || item.principal !== AUTOMATION_CONDITIONAL_CLI_PRINCIPAL
          || item.action !== 'cancel' || item.source !== null || item.operation !== null
          || item.outputId !== null || !OPAQUE_ID.test(item.jobId ?? '')) deny();
        return true;
      }

      deny();
    },
  });
}
