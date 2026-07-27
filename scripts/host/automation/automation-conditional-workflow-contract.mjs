import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import { AUTOMATION_INSPECT_TYPE } from './automation-operation-contract.mjs';
import { normalizeAutomationApiSubmitRequest } from './automation-api-contract.mjs';

export const AUTOMATION_CONDITIONAL_WORKFLOW_SCHEMA_VERSION = 1;
export const AUTOMATION_CONDITIONAL_MAX_STEPS = 8;
export const AUTOMATION_CONDITIONAL_MAX_REPEATS = 4;
export const AUTOMATION_CONDITIONAL_MAX_SUBMISSIONS = 16;
export const AUTOMATION_CONDITIONAL_MAX_EXECUTIONS = 64;
export const AUTOMATION_CONDITIONAL_MAX_IDEMPOTENCY_BYTES = 96;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/u;
const FIELDS = new Set([
  'document.pageCount', 'document.encrypted', 'document.tagged', 'document.optimized',
  'workflow.queuedCount', 'workflow.previousStatus',
]);

export function conditionalFail(code, message, status = 400, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', `${label} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key)
    || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) {
    conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', `${label} contains unsupported fields, accessors, or symbols.`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function dense(value, label, maximum) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length < 1 || value.length > maximum) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', `${label} is outside its fixed bound.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key)
    || Number(key) >= value.length || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) {
    conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', `${label} must be a dense data-only array.`);
  }
  return Array.from({ length: value.length }, (_, index) => descriptors[String(index)].value);
}

function condition(value) {
  const item = exact(value, ['field', 'operator', 'value'], 'conditional predicate');
  if (!FIELDS.has(item.field)) conditionalFail('AUTOMATION_CONDITION_DENIED', 'Conditional field is not allowlisted.', 403);
  if (['document.pageCount', 'workflow.queuedCount'].includes(item.field)) {
    if (!['eq', 'gte', 'lte'].includes(item.operator) || !Number.isSafeInteger(item.value) || item.value < 0 || item.value > 100_000) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', 'Numeric predicate is invalid.');
  } else if (item.field === 'workflow.previousStatus') {
    if (item.operator !== 'eq' || !['none', 'queued', 'skipped'].includes(item.value)) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', 'Status predicate is invalid.');
  } else if (item.operator !== 'eq' || ![true, false].includes(item.value)) {
    conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', 'Boolean predicate is invalid.');
  }
  return Object.freeze({ field: item.field, operator: item.operator, value: item.value });
}

function operation(value) {
  if (value === null) return null;
  const normalized = normalizeAutomationApiSubmitRequest({
    principal: 'conditional.caller', grant: { grantId: 'conditional_grant', principal: 'conditional.caller' },
    source: { id: 'conditional_source', sha256: 'a'.repeat(64) }, operation: value,
    idempotencyKey: 'conditional-validation',
  });
  return normalized.operation;
}

function branch(value, label) {
  const item = exact(value, ['operation', 'repeat'], label);
  if (!Number.isSafeInteger(item.repeat) || item.repeat < 1 || item.repeat > AUTOMATION_CONDITIONAL_MAX_REPEATS) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', `${label} repeat is outside its fixed bound.`);
  const selected = operation(item.operation);
  if (selected === null && item.repeat !== 1) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', `${label} cannot repeat an empty branch.`);
  return Object.freeze({ operation: selected, repeat: item.repeat });
}

function workflow(value) {
  const item = exact(value, ['steps', 'workflowId'], 'conditional workflow');
  if (typeof item.workflowId !== 'string' || !IDENTIFIER.test(item.workflowId)) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', 'Conditional workflow ID is invalid.');
  const ids = new Set();
  let maximumSubmissions = 0;
  const steps = dense(item.steps, 'conditional steps', AUTOMATION_CONDITIONAL_MAX_STEPS).map((raw) => {
    const step = exact(raw, ['condition', 'falseBranch', 'stepId', 'trueBranch'], 'conditional step');
    if (typeof step.stepId !== 'string' || !IDENTIFIER.test(step.stepId) || ids.has(step.stepId)) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', 'Conditional step ID is invalid or duplicated.');
    ids.add(step.stepId);
    const trueBranch = branch(step.trueBranch, 'true branch');
    const falseBranch = branch(step.falseBranch, 'false branch');
    if (trueBranch.operation === null && falseBranch.operation === null) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', 'A conditional step must queue at least one branch.');
    maximumSubmissions += Math.max(trueBranch.operation ? trueBranch.repeat : 0, falseBranch.operation ? falseBranch.repeat : 0);
    return Object.freeze({ stepId: step.stepId, condition: condition(step.condition), trueBranch, falseBranch });
  });
  if (maximumSubmissions > AUTOMATION_CONDITIONAL_MAX_SUBMISSIONS) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', 'Conditional workflow exceeds the submission bound.');
  return Object.freeze({ workflowId: item.workflowId, steps: Object.freeze(steps) });
}

export function normalizeAutomationConditionalExecuteRequest(value) {
  const item = exact(value, ['grant', 'idempotencyKey', 'principal', 'source', 'workflow'], 'conditional execute request');
  if (typeof item.idempotencyKey !== 'string' || Buffer.byteLength(item.idempotencyKey, 'utf8') < 1
    || Buffer.byteLength(item.idempotencyKey, 'utf8') > AUTOMATION_CONDITIONAL_MAX_IDEMPOTENCY_BYTES
    || /[\u0000-\u001f\u007f]/u.test(item.idempotencyKey)) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', 'Conditional idempotency key is invalid.');
  const base = normalizeAutomationApiSubmitRequest({
    principal: item.principal, grant: item.grant, source: item.source,
    operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null },
    idempotencyKey: item.idempotencyKey,
  });
  return Object.freeze({ schemaVersion: 1, principal: base.principal, grant: base.grant, source: base.source, workflow: workflow(item.workflow), idempotencyKey: item.idempotencyKey });
}

export function normalizeAutomationConditionalCancelRequest(value) {
  const item = exact(value, ['executionId', 'grant', 'principal'], 'conditional cancel request');
  const base = normalizeAutomationApiSubmitRequest({
    principal: item.principal, grant: item.grant, source: { id: 'conditional_source', sha256: 'a'.repeat(64) },
    operation: { kind: 'operation', id: AUTOMATION_INSPECT_TYPE, pages: null }, idempotencyKey: 'conditional-cancel',
  });
  if (typeof item.executionId !== 'string' || !/^cw_[a-f0-9]{32}$/u.test(item.executionId)) conditionalFail('INVALID_AUTOMATION_CONDITIONAL_WORKFLOW', 'Conditional execution ID is invalid.');
  return Object.freeze({ schemaVersion: 1, principal: base.principal, grant: base.grant, executionId: item.executionId });
}

export function conditionalWorkflowFingerprint(request) {
  return createHash('sha256').update(JSON.stringify({ principal: request.principal, grant: request.grant, source: request.source, workflow: request.workflow }), 'utf8').digest('hex');
}

export function conditionalExecutionId(request) {
  return `cw_${createHash('sha256').update(JSON.stringify({ principal: request.principal, source: request.source, workflow: request.workflow, idempotencyKey: request.idempotencyKey }), 'utf8').digest('hex').slice(0, 32)}`;
}
