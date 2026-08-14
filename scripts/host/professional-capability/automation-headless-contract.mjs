import { createHash, randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  canonicalWatchDirectory,
  snapshotPdfDirectory,
  stablePdfCandidates,
} from '../watch-folder.mjs';
import {
  AUTOMATION_OPERATION_IDS,
  publicAutomationApiReceipt,
  normalizeAutomationApiSubmitRequest,
} from '../automation/automation-api-contract.mjs';
import {
  AUTOMATION_INSPECT_PRESET,
  AUTOMATION_PRESET_IDS,
  automationPresetDescriptor,
} from '../automation/automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_IDS, automationSequenceDescriptor } from '../automation/automation-sequence-contract.mjs';
import {
  AUTOMATION_JS_LIMITATIONS,
  AUTOMATION_JS_PROFILE,
} from '../automation/automation-js-contract.mjs';
import { automationJsExecutionId } from '../automation/automation-js-contract.mjs';
import { conditionalExecutionId } from '../automation/automation-conditional-workflow-contract.mjs';
import { AutomationJsRecipeRegistry } from '../automation/automation-js-registry.mjs';
import { HostError } from '../host-error.mjs';
import { result, fail, requireString } from './support.mjs';

function digestSeed(type, seed) {
  return createHash('sha256').update(`${type}|${String(seed ?? randomUUID())}`).digest('hex').slice(0, 32);
}

const API_OPERATIONS = Object.freeze(new Set([
  'compose', 'split', 'compress', 'export', 'preflight', 'print', 'ocr', 'merge',
]));

const SEQUENCE_OPS = Object.freeze(new Set([
  'open', 'compress', 'save', 'export', 'merge', 'split', 'watermark', 'encrypt', 'ocr',
]));

const PREFLIGHT_PROFILES = Object.freeze(new Set([
  'print-review', 'web-optimize', 'pdfa-2b', 'accessibility-lite', 'archive',
]));

const AUTOMATION_SERVICE_REQUIRED = 'AUTOMATION_SERVICE_REQUIRED';
const AUTOMATION_JS_RECIPE_IDS = Object.freeze(new AutomationJsRecipeRegistry().list().map(({ id }) => id));

function plainData(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('INVALID_AUTOMATION_INPUT', `${label} must be a plain data object.`, 400);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string'
    || !keys.includes(key) || !Object.hasOwn(descriptors, key)
    || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) {
    fail('INVALID_AUTOMATION_INPUT', `${label} contains unsupported fields or accessors.`, 400);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function sourceBinding(ctx) {
  const source = plainData(ctx.source, 'source', ['id', 'sha256']);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(source.id ?? '') || !/^[a-f0-9]{64}$/u.test(source.sha256 ?? '')) {
    fail('INVALID_AUTOMATION_INPUT', 'source must contain an opaque id and SHA-256 binding.', 400);
  }
  return Object.freeze({ id: source.id, sha256: source.sha256 });
}

function callerBinding(ctx) {
  const principal = requireString(ctx.principal, 'principal', { min: 1, max: 128 });
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(principal)) {
    fail('INVALID_AUTOMATION_INPUT', 'principal is not a valid automation caller.', 400);
  }
  const grant = plainData(ctx.grant, 'grant', ['grantId', 'principal']);
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(grant.grantId ?? '') || grant.principal !== principal) {
    fail('AUTOMATION_GRANT_MISMATCH', 'Automation grant does not match the caller.', 403);
  }
  return Object.freeze({ principal, grant: Object.freeze({ grantId: grant.grantId, principal }) });
}

function requiredService(ctx, name) {
  const service = ctx.automation?.[name];
  if (!service || typeof service !== 'object') {
    fail(AUTOMATION_SERVICE_REQUIRED, `A local automation ${name} service is required.`, 503);
  }
  return service;
}

function checkedQueueResponse(value, expectedType = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('AUTOMATION_RESULT_INVALID', 'Automation queue response is invalid.', 502);
  }
  const responseDescriptors = Object.getOwnPropertyDescriptors(value);
  const responseKeys = ['schemaVersion', 'idempotent', 'job'];
  if (Reflect.ownKeys(value).length !== responseKeys.length || responseKeys.some((key) => !Object.hasOwn(responseDescriptors, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
    || !Object.hasOwn(responseDescriptors, key)
    || !Object.hasOwn(responseDescriptors[key], 'value')
    || responseDescriptors[key].enumerable !== true)) {
    fail('AUTOMATION_RESULT_INVALID', 'Automation queue response contains an accessor.', 502);
  }
  const response = Object.freeze({
    schemaVersion: value.schemaVersion,
    idempotent: value.idempotent,
    job: value.job,
  });
  if (response.schemaVersion !== 1 || typeof response.idempotent !== 'boolean') {
    fail('AUTOMATION_RESULT_INVALID', 'Automation queue response schema is invalid.', 502);
  }
  const jobValue = response.job;
  if (!jobValue || typeof jobValue !== 'object' || Array.isArray(jobValue)
    || nodeTypes.isProxy(jobValue) || Object.getPrototypeOf(jobValue) !== Object.prototype) {
    fail('AUTOMATION_RESULT_INVALID', 'Automation queue job is invalid.', 502);
  }
  const jobDescriptors = Object.getOwnPropertyDescriptors(jobValue);
  if (Reflect.ownKeys(jobValue).some((key) => typeof key !== 'string'
    || !Object.hasOwn(jobDescriptors, key)
    || !Object.hasOwn(jobDescriptors[key], 'value')
    || jobDescriptors[key].enumerable !== true)) {
    fail('AUTOMATION_RESULT_INVALID', 'Automation queue job contains an accessor.', 502);
  }
  const job = checkedApiJob(jobValue, jobValue.id, expectedType);
  return Object.freeze({
    schemaVersion: 1,
    idempotent: response.idempotent,
    job,
  });
}

function submitRequest(ctx, operation, suffix) {
  const caller = callerBinding(ctx);
  const source = sourceBinding(ctx);
  const idempotencyKey = requireString(
    ctx.idempotencyKey ?? `${suffix}-${source.sha256}`,
    'idempotencyKey', { min: 1, max: 256 },
  );
  try {
    const normalized = normalizeAutomationApiSubmitRequest({
      principal: caller.principal, grant: caller.grant, source, operation, idempotencyKey,
    });
    // The shipped API accepts this exact five-field request shape. Keep the
    // normalized values, but do not leak the normalizer's internal schema field
    // across the service boundary.
    return Object.freeze({
      principal: normalized.principal,
      grant: normalized.grant,
      source: normalized.source,
      operation: normalized.operation,
      idempotencyKey: normalized.idempotencyKey,
    });
  } catch (error) {
    if (error?.code?.startsWith('AUTOMATION_')) throw error;
    fail('INVALID_AUTOMATION_INPUT', 'Automation submission binding is invalid.', 400);
  }
}

function operationSelection(kind, id) {
  return Object.freeze({ kind, id, pages: null });
}

function checkedApiJob(value, expectedId, expectedType = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('AUTOMATION_RESULT_INVALID', 'Automation API job status is invalid.', 502);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const jobKeys = ['id', 'type', 'status', 'attempts', 'maxAttempts', 'createdAt', 'updatedAt', 'retry', 'receipt'];
  if (Reflect.ownKeys(value).length !== jobKeys.length || jobKeys.some((key) => !Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
    || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')
    || descriptors[key].enumerable !== true)) {
    fail('AUTOMATION_RESULT_INVALID', 'Automation API job status contains an accessor.', 502);
  }
  if (value.id !== expectedId || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.id ?? '')
    || (expectedType && value.type !== expectedType)
    || !(AUTOMATION_OPERATION_IDS.includes(value.type) || value.type === 'automation_sequence_v1')
    || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(value.status)
    || !Number.isSafeInteger(value.attempts) || !Number.isSafeInteger(value.maxAttempts)
    || value.attempts < 0 || value.maxAttempts < 1 || value.attempts > value.maxAttempts
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)) {
    fail('AUTOMATION_RESULT_INVALID', 'Automation API job status identity is invalid.', 502);
  }
  if (value.retry !== null) {
    const retry = value.retry;
    if (!retry || Object.getPrototypeOf(retry) !== Object.prototype) {
      fail('AUTOMATION_RESULT_INVALID', 'Automation API retry evidence is invalid.', 502);
    }
    const retryDescriptors = Object.getOwnPropertyDescriptors(retry);
    if (Reflect.ownKeys(retry).length !== 2 || !Object.hasOwn(retryDescriptors, 'classification')
      || !Object.hasOwn(retryDescriptors, 'notBefore')
      || Reflect.ownKeys(retry).some((key) => !Object.hasOwn(retryDescriptors[key], 'value')
        || retryDescriptors[key].enumerable !== true)
      || !['transient', 'interrupted'].includes(retry.classification)
      || !Number.isSafeInteger(retry.notBefore)) {
      fail('AUTOMATION_RESULT_INVALID', 'Automation API retry evidence is invalid.', 502);
    }
  }
  let receipt = null;
  if (value.receipt !== null) {
    try { receipt = publicAutomationApiReceipt(value.receipt); }
    catch (error) { fail('AUTOMATION_RESULT_INVALID', 'Automation API job receipt is invalid.', 502, error); }
  }
  return Object.freeze({
    id: value.id, type: value.type, status: value.status, attempts: value.attempts,
    maxAttempts: value.maxAttempts, createdAt: value.createdAt, updatedAt: value.updatedAt,
    retry: value.retry === null ? null : Object.freeze({
      classification: value.retry.classification, notBefore: value.retry.notBefore,
    }), receipt,
  });
}

function exactResultObject(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('AUTOMATION_RESULT_INVALID', `${label} is invalid.`, 502);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) {
    fail('AUTOMATION_RESULT_INVALID', `${label} shape is invalid.`, 502);
  }
  return value;
}

function exactResultArray(value, label, maximum = 500) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > maximum) {
    fail('AUTOMATION_RESULT_INVALID', `${label} is invalid.`, 502);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1
    || Reflect.ownKeys(value).some((key) => key !== 'length' && (typeof key !== 'string'
      || !/^\d+$/u.test(key) || !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true))) {
    fail('AUTOMATION_RESULT_INVALID', `${label} contains accessors or sparse entries.`, 502);
  }
  return Array.from({ length: value.length }, (_, index) => descriptors[String(index)].value);
}

function checkedJavascriptExecution(value, request) {
  const execution = exactResultObject(value, 'Declarative recipe result', [
    'schemaVersion', 'executionId', 'recipe', 'source', 'status', 'queuedCount',
    'jobs', 'limitations', 'javascriptExecuted', 'localOnly',
  ]);
  const expectedExecutionId = automationJsExecutionId(request);
  if (execution.schemaVersion !== 1 || execution.executionId !== expectedExecutionId
    || execution.status !== 'completed' || execution.javascriptExecuted !== false
    || execution.localOnly !== true || !Number.isSafeInteger(execution.queuedCount)
    || !Array.isArray(execution.jobs) || execution.jobs.length !== execution.queuedCount) {
    fail('AUTOMATION_RESULT_INVALID', 'Declarative recipe result semantics are invalid.', 502);
  }
  const limitations = exactResultArray(execution.limitations, 'Declarative recipe limitations', 8);
  if (JSON.stringify(limitations) !== JSON.stringify(AUTOMATION_JS_LIMITATIONS)) {
    fail('AUTOMATION_RESULT_INVALID', 'Declarative recipe limitations are invalid.', 502);
  }
  const recipe = exactResultObject(execution.recipe, 'Declarative recipe selection', ['id', 'version', 'repeat']);
  if (recipe.id !== request.recipe.id || recipe.version !== 1 || recipe.repeat !== request.recipe.repeat) {
    fail('AUTOMATION_RESULT_INVALID', 'Declarative recipe result is not bound to the request.', 502);
  }
  const source = exactResultObject(execution.source, 'Declarative recipe source', ['id', 'sha256']);
  if (source.id !== request.source.id || source.sha256 !== request.source.sha256) {
    fail('AUTOMATION_RESULT_INVALID', 'Declarative recipe source binding drifted.', 502);
  }
  for (const job of exactResultArray(execution.jobs, 'Declarative recipe jobs', 32)) {
    const checked = exactResultObject(job, 'Declarative recipe job', ['iteration', 'stepId', 'id', 'type', 'status', 'idempotent']);
    if (!Number.isSafeInteger(checked.iteration) || checked.iteration < 1
      || typeof checked.stepId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(checked.stepId)
      || !/^[A-Za-z0-9_-]{1,128}$/u.test(checked.id ?? '')
      || !['automation_inspect_v1', 'automation_ocr_v1', 'automation_output_intent_v1'].includes(checked.type)
      || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(checked.status)
      || typeof checked.idempotent !== 'boolean') {
      fail('AUTOMATION_RESULT_INVALID', 'Declarative recipe job semantics are invalid.', 502);
    }
  }
  return Object.freeze({ ...execution });
}

function checkedScheduleResult(value, request) {
  const schedule = exactResultObject(value, 'Schedule result', [
    'schemaVersion', 'scheduleId', 'principal', 'source', 'operation', 'firstAt', 'intervalMs',
    'nextAt', 'status', 'runCount', 'runs', 'createdAt', 'updatedAt',
  ]);
  const source = exactResultObject(schedule.source, 'Schedule source', ['id', 'sha256']);
  const operation = exactResultObject(schedule.operation, 'Schedule operation', ['id', 'kind', 'pages']);
  if (schedule.schemaVersion !== 1 || schedule.scheduleId !== request.scheduleId
    || schedule.principal !== request.principal
    || source.id !== request.source.id || source.sha256 !== request.source.sha256
    || operation.id !== request.operation.id || operation.kind !== request.operation.kind
    || operation.pages !== null || !Number.isSafeInteger(schedule.firstAt)
    || (schedule.intervalMs !== null && !Number.isSafeInteger(schedule.intervalMs))
    || (schedule.nextAt !== null && !Number.isSafeInteger(schedule.nextAt))
    || !['enabled', 'disabled', 'cancelled', 'completed'].includes(schedule.status)
    || !Number.isSafeInteger(schedule.runCount) || !Array.isArray(schedule.runs)
    || !Number.isSafeInteger(schedule.createdAt) || !Number.isSafeInteger(schedule.updatedAt)) {
    fail('AUTOMATION_RESULT_INVALID', 'Schedule result semantics are invalid.', 502);
  }
  for (const run of exactResultArray(schedule.runs, 'Schedule runs', 256)) {
    const checked = exactResultObject(run, 'Schedule run', ['occurrence', 'scheduledAt', 'status', 'jobId', 'startedAt', 'finishedAt', 'errorCode']);
    if (typeof checked.occurrence !== 'string' || !Number.isSafeInteger(checked.scheduledAt)
      || !['admitting', 'pending', 'queued'].includes(checked.status)
      || (checked.jobId !== null && typeof checked.jobId !== 'string')
      || (checked.startedAt !== null && !Number.isSafeInteger(checked.startedAt))
      || (checked.finishedAt !== null && !Number.isSafeInteger(checked.finishedAt))
      || (checked.errorCode !== null && typeof checked.errorCode !== 'string')) {
      fail('AUTOMATION_RESULT_INVALID', 'Schedule run semantics are invalid.', 502);
    }
  }
  return Object.freeze({ ...schedule });
}

function checkedConditionalExecution(value, request) {
  const execution = exactResultObject(value, 'Conditional workflow result', [
    'schemaVersion', 'executionId', 'workflowId', 'source', 'factsDigest',
    'queuedCount', 'status', 'steps', 'localOnly',
  ]);
  const source = exactResultObject(execution.source, 'Conditional source', ['id', 'sha256']);
  if (execution.schemaVersion !== 1 || execution.executionId !== conditionalExecutionId(request)
    || execution.workflowId !== request.workflow.workflowId || source.id !== request.source.id
    || source.sha256 !== request.source.sha256 || !/^[a-f0-9]{64}$/u.test(execution.factsDigest ?? '')
    || !Number.isSafeInteger(execution.queuedCount) || !Array.isArray(execution.steps)
    || execution.steps.length !== request.workflow.steps.length
    || execution.status !== 'completed' || execution.localOnly !== true) {
    fail('AUTOMATION_RESULT_INVALID', 'Conditional workflow result semantics are invalid.', 502);
  }
  let queuedCount = 0;
  for (const step of exactResultArray(execution.steps, 'Conditional workflow steps', 8)) {
    const checked = exactResultObject(step, 'Conditional workflow step', ['stepId', 'matched', 'branch', 'status', 'jobs']);
    if (typeof checked.stepId !== 'string' || typeof checked.matched !== 'boolean'
      || !['true', 'false'].includes(checked.branch) || !['queued', 'skipped'].includes(checked.status)
      || !Array.isArray(checked.jobs)) fail('AUTOMATION_RESULT_INVALID', 'Conditional workflow step semantics are invalid.', 502);
    for (const job of exactResultArray(checked.jobs, 'Conditional workflow jobs', 4)) {
      const admitted = exactResultObject(job, 'Conditional workflow job', ['iteration', 'id', 'status', 'idempotent']);
      if (!Number.isSafeInteger(admitted.iteration) || !/^[A-Za-z0-9_-]{1,128}$/u.test(admitted.id ?? '')
        || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(admitted.status)
        || typeof admitted.idempotent !== 'boolean') fail('AUTOMATION_RESULT_INVALID', 'Conditional workflow job semantics are invalid.', 502);
      queuedCount += 1;
    }
  }
  if (queuedCount !== execution.queuedCount) fail('AUTOMATION_RESULT_INVALID', 'Conditional workflow queue count is inconsistent.', 502);
  return Object.freeze({ ...execution });
}

/** Validate classic 5-field cron: min hour dom mon dow (ranges / steps / lists / *). */

export {
  API_OPERATIONS,
  AUTOMATION_SERVICE_REQUIRED,
  AUTOMATION_JS_RECIPE_IDS,
  PREFLIGHT_PROFILES,
  SEQUENCE_OPS,
  checkedApiJob,
  checkedConditionalExecution,
  checkedJavascriptExecution,
  checkedQueueResponse,
  checkedScheduleResult,
  digestSeed,
  exactResultArray,
  operationSelection,
  plainData,
  requiredService,
  callerBinding,
  sourceBinding,
  submitRequest,
};
