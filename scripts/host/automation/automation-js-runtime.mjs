import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import {
  AUTOMATION_JS_LIMITATIONS,
  AUTOMATION_JS_MAX_ADMISSIONS,
  AUTOMATION_JS_MAX_STEPS,
} from './automation-js-contract.mjs';
import {
  AUTOMATION_INSPECT_PRESET,
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_PRESET,
  AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_PRESET,
  AUTOMATION_OUTPUT_INTENT_TYPE,
} from './automation-operation-contract.mjs';

function expectedType(operation) {
  if (operation.kind === 'preset') {
    if (operation.id === AUTOMATION_INSPECT_PRESET) return AUTOMATION_INSPECT_TYPE;
    if (operation.id === AUTOMATION_OCR_PRESET) return AUTOMATION_OCR_TYPE;
    if (operation.id === AUTOMATION_OUTPUT_INTENT_PRESET) return AUTOMATION_OUTPUT_INTENT_TYPE;
  }
  return null;
}

function exactDataObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new HostError('AUTOMATION_JS_RECIPE_INVALID', `${label} is invalid.`, 502);
  }
  let fields;
  try { fields = Object.getOwnPropertyDescriptors(value); } catch { fields = null; }
  const actual = fields ? Reflect.ownKeys(fields) : [];
  if (!fields || actual.length !== keys.length || actual.some((key) => (
    typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(fields[key], 'value')
    || fields[key].enumerable !== true
  ))) {
    throw new HostError('AUTOMATION_JS_RECIPE_INVALID', `${label} is invalid.`, 502);
  }
  return Object.fromEntries(keys.map((key) => [key, fields[key].value]));
}

function checkedArray(value, maximum, label) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new HostError('AUTOMATION_JS_RECIPE_INVALID', `${label} is invalid.`, 502);
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  const length = fields.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > maximum
    || Reflect.ownKeys(fields).length !== length + 1) {
    throw new HostError('AUTOMATION_JS_RECIPE_INVALID', `${label} is invalid.`, 502);
  }
  return Array.from({ length }, (_, index) => {
    const field = fields[String(index)];
    if (!field || !Object.hasOwn(field, 'value') || field.enumerable !== true) {
      throw new HostError('AUTOMATION_JS_RECIPE_INVALID', `${label} is invalid.`, 502);
    }
    return field.value;
  });
}

function checkedDescriptor(value, request) {
  const descriptor = exactDataObject(value, ['id', 'schemaVersion', 'steps', 'version'],
    'Declarative recipe descriptor');
  if (descriptor.schemaVersion !== 1 || descriptor.version !== request.recipe.version
    || descriptor.id !== request.recipe.id) {
    throw new HostError('AUTOMATION_JS_RECIPE_INVALID', 'Declarative recipe descriptor is invalid.', 502);
  }
  const steps = checkedArray(descriptor.steps, AUTOMATION_JS_MAX_STEPS,
    'Declarative recipe steps').map((value) => {
    const item = exactDataObject(value, ['id', 'operation'], 'Declarative recipe step');
    const operation = exactDataObject(item.operation, ['id', 'kind', 'pages'],
      'Declarative recipe operation');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(item.id ?? '')
      || operation.kind !== 'preset' || operation.pages !== null || expectedType(operation) === null) {
      throw new HostError('AUTOMATION_JS_RECIPE_INVALID', 'Declarative recipe step is invalid.', 502);
    }
    return Object.freeze({ id: item.id, operation: Object.freeze(operation) });
  });
  if (steps.length * request.recipe.repeat > AUTOMATION_JS_MAX_ADMISSIONS) {
    throw new HostError('AUTOMATION_JS_RECIPE_INVALID', 'Declarative recipe admission bound is invalid.', 502);
  }
  return Object.freeze({ id: descriptor.id, version: descriptor.version, steps: Object.freeze(steps) });
}

function checkedJob(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new HostError('AUTOMATION_JS_QUEUE_RESULT_INVALID', 'Declarative recipe queue response is invalid.', 502);
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 3 || !Object.hasOwn(fields, 'schemaVersion')
    || !Object.hasOwn(fields, 'idempotent') || !Object.hasOwn(fields, 'job')
    || Reflect.ownKeys(value).some((key) => !Object.hasOwn(fields[key], 'value')
      || fields[key].enumerable !== true) || fields.schemaVersion.value !== 1
    || typeof fields.idempotent.value !== 'boolean') {
    throw new HostError('AUTOMATION_JS_QUEUE_RESULT_INVALID', 'Declarative recipe queue response is invalid.', 502);
  }
  const job = fields.job.value;
  if (!job || typeof job !== 'object' || Array.isArray(job) || nodeTypes.isProxy(job)
    || Object.getPrototypeOf(job) !== Object.prototype) {
    throw new HostError('AUTOMATION_JS_QUEUE_RESULT_INVALID', 'Declarative recipe queue job is invalid.', 502);
  }
  const jobFields = Object.getOwnPropertyDescriptors(job);
  if (!Object.hasOwn(jobFields, 'id') || !Object.hasOwn(jobFields, 'type')
    || !Object.hasOwn(jobFields, 'status')
    || Reflect.ownKeys(job).some((key) => typeof key !== 'string'
      || !Object.hasOwn(jobFields[key], 'value') || jobFields[key].enumerable !== true)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(jobFields.id.value ?? '')
    || jobFields.type.value !== expectedType(operation)
    || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(jobFields.status.value)) {
    throw new HostError('AUTOMATION_JS_QUEUE_RESULT_INVALID', 'Declarative recipe queue job identity is invalid.', 502);
  }
  return Object.freeze({
    id: jobFields.id.value,
    type: jobFields.type.value,
    status: jobFields.status.value,
    idempotent: fields.idempotent.value,
  });
}

function observedJobId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return null;
  let fields;
  try { fields = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  const jobField = fields.job;
  if (!jobField || !Object.hasOwn(jobField, 'value') || jobField.enumerable !== true) return null;
  const job = jobField.value;
  if (!job || typeof job !== 'object' || Array.isArray(job) || nodeTypes.isProxy(job)
    || Object.getPrototypeOf(job) !== Object.prototype) return null;
  let jobFields;
  try { jobFields = Object.getOwnPropertyDescriptors(job); } catch { return null; }
  const idField = jobFields.id;
  if (!idField || !Object.hasOwn(idField, 'value') || idField.enumerable !== true
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(idField.value ?? '')) return null;
  return idField.value;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw new HostError('AUTOMATION_JS_CANCELLED', 'Declarative recipe execution was cancelled.', 499);
  }
}

function occurrenceKey(executionId, iteration, stepId) {
  return `automation-js:${executionId}:${iteration}:${stepId}`;
}

export async function executeAutomationJsRecipe({ request, descriptor, submit, onAdmitted, signal }) {
  if (typeof submit !== 'function' || (onAdmitted !== undefined && typeof onAdmitted !== 'function')) {
    throw new HostError('AUTOMATION_JS_RECIPE_INVALID', 'Declarative recipe descriptor is invalid.', 502);
  }
  const recipe = checkedDescriptor(descriptor, request);
  const jobs = [];
  for (let iteration = 1; iteration <= request.recipe.repeat; iteration += 1) {
    for (const step of recipe.steps) {
      throwIfCancelled(signal);
      const idempotencyKey = occurrenceKey(request.executionId, iteration, step.id);
      const response = await submit(step.operation, idempotencyKey);
      const jobId = observedJobId(response);
      if (jobId !== null) onAdmitted?.(jobId, idempotencyKey);
      const queued = checkedJob(response, step.operation);
      jobs.push(Object.freeze({
        iteration, stepId: step.id, id: queued.id, type: queued.type,
        status: queued.status, idempotent: queued.idempotent,
      }));
      throwIfCancelled(signal);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    executionId: request.executionId,
    recipe: Object.freeze({ id: recipe.id, version: recipe.version,
      repeat: request.recipe.repeat }),
    source: Object.freeze({ id: request.source.id, sha256: request.source.sha256 }),
    status: 'completed',
    queuedCount: jobs.length,
    jobs: Object.freeze(jobs),
    limitations: AUTOMATION_JS_LIMITATIONS,
    javascriptExecuted: false,
    localOnly: true,
  });
}
