import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import {
  AUTOMATION_API_MAX_IDEMPOTENCY_KEY_BYTES,
  normalizeAutomationApiSubmitRequest,
} from './automation-api-contract.mjs';

export const AUTOMATION_SCHEDULE_SCHEMA_VERSION = 1;
export const AUTOMATION_SCHEDULE_MIN_INTERVAL_MS = 60_000;
export const AUTOMATION_SCHEDULE_MAX_SCHEDULES = 64;
export const AUTOMATION_SCHEDULE_MAX_RUNS = 256;
export const AUTOMATION_SCHEDULE_MAX_CATCH_UP_MS = 60 * 60 * 1000;
export const AUTOMATION_SCHEDULE_MAX_RECORD_BYTES = 512 * 1024;
export const AUTOMATION_SCHEDULE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export function scheduleFail(code, message, status = 400, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    scheduleFail('INVALID_AUTOMATION_SCHEDULE', `${label} must be a plain object.`);
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { descriptors = null; }
  const actual = descriptors ? Reflect.ownKeys(value) : [];
  if (!descriptors || actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key)
      || !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')
      || descriptors[key].enumerable !== true)) {
    scheduleFail('INVALID_AUTOMATION_SCHEDULE', `${label} contains unsupported fields, accessors, or symbols.`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function principal(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(value)) {
    scheduleFail('INVALID_AUTOMATION_SCHEDULE', 'Schedule principal is invalid.');
  }
  return value;
}

function grant(value, caller) {
  const item = exact(value, ['grantId', 'principal'], 'schedule capability grant');
  if (typeof item.grantId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(item.grantId)
    || item.principal !== caller) {
    scheduleFail('AUTOMATION_SCHEDULE_GRANT_MISMATCH', 'Schedule capability grant does not match the caller.', 403);
  }
  return Object.freeze({ grantId: item.grantId, principal: item.principal });
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    scheduleFail('INVALID_AUTOMATION_SCHEDULE', `${label} must be a non-negative UTC epoch millisecond integer.`);
  }
  return value;
}

function source(value) {
  const item = exact(value, ['id', 'sha256'], 'schedule source');
  if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.id)
    || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) {
    scheduleFail('INVALID_AUTOMATION_SCHEDULE', 'Schedule source binding is invalid.');
  }
  return Object.freeze({ id: item.id, sha256: item.sha256 });
}

function operation(value) {
  const item = exact(value, ['id', 'kind', 'pages'], 'schedule operation');
  // Delegate the allowlist and page validation to the already exercised API boundary.
  const normalized = normalizeAutomationApiSubmitRequest({
    principal: 'schedule.caller',
    grant: { grantId: 'schedule_grant', principal: 'schedule.caller' },
    source: { id: 'schedule_source', sha256: 'a'.repeat(64) },
    operation: item,
    idempotencyKey: 'schedule-validation',
  });
  return normalized.operation;
}

export function normalizeAutomationScheduleCreateRequest(value, now = Date.now()) {
  const item = exact(value, ['firstAt', 'grant', 'intervalMs', 'operation', 'principal', 'scheduleId', 'source'], 'schedule create request');
  const caller = principal(item.principal);
  const capabilityGrant = grant(item.grant, caller);
  if (typeof item.scheduleId !== 'string' || !AUTOMATION_SCHEDULE_ID.test(item.scheduleId)) {
    scheduleFail('INVALID_AUTOMATION_SCHEDULE', 'Schedule ID is invalid.');
  }
  const firstAt = timestamp(item.firstAt, 'Schedule firstAt');
  const intervalMs = item.intervalMs === null ? null : item.intervalMs;
  if (intervalMs !== null && (!Number.isSafeInteger(intervalMs) || intervalMs < AUTOMATION_SCHEDULE_MIN_INTERVAL_MS)) {
    scheduleFail('INVALID_AUTOMATION_SCHEDULE', 'Schedule interval is below the fixed minimum.');
  }
  if (firstAt > Number.MAX_SAFE_INTEGER - (intervalMs ?? 0)) {
    scheduleFail('INVALID_AUTOMATION_SCHEDULE', 'Schedule time exceeds the safe UTC epoch range.');
  }
  if (!Number.isSafeInteger(now) || now < 0) scheduleFail('INVALID_AUTOMATION_SCHEDULE', 'Schedule clock is invalid.', 500);
  return Object.freeze({
    schemaVersion: AUTOMATION_SCHEDULE_SCHEMA_VERSION,
    scheduleId: item.scheduleId,
    principal: caller,
    grant: capabilityGrant,
    source: source(item.source),
    operation: operation(item.operation),
    firstAt,
    intervalMs,
  });
}

export function normalizeAutomationScheduleJobRequest(value, action = 'schedule') {
  const item = exact(value, ['grant', 'principal', 'scheduleId'], `schedule ${action} request`);
  const caller = principal(item.principal);
  const capabilityGrant = grant(item.grant, caller);
  if (typeof item.scheduleId !== 'string' || !AUTOMATION_SCHEDULE_ID.test(item.scheduleId)) {
    scheduleFail('INVALID_AUTOMATION_SCHEDULE', 'Schedule ID is invalid.');
  }
  return Object.freeze({ schemaVersion: AUTOMATION_SCHEDULE_SCHEMA_VERSION, principal: caller, grant: capabilityGrant, scheduleId: item.scheduleId });
}

export function normalizeAutomationScheduleListRequest(value) {
  const item = exact(value, ['grant', 'principal'], 'schedule list request');
  const caller = principal(item.principal);
  return Object.freeze({ schemaVersion: AUTOMATION_SCHEDULE_SCHEMA_VERSION, principal: caller, grant: grant(item.grant, caller) });
}

export function scheduleOccurrenceKey(scheduleId, scheduledAt) {
  timestamp(scheduledAt, 'Schedule occurrence time');
  const key = `automation-schedule:${scheduleId}:${scheduledAt}`;
  if (Buffer.byteLength(key, 'utf8') > AUTOMATION_API_MAX_IDEMPOTENCY_KEY_BYTES) {
    scheduleFail('INVALID_AUTOMATION_SCHEDULE', 'Schedule occurrence key exceeds the idempotency bound.');
  }
  return key;
}

export function publicAutomationSchedule(record) {
  const plain = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) scheduleFail('AUTOMATION_SCHEDULE_RESULT_INVALID', `${label} is invalid.`, 502);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !Object.hasOwn(descriptors, key)
      || !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) {
      scheduleFail('AUTOMATION_SCHEDULE_RESULT_INVALID', `${label} contains an accessor.`, 502);
    }
    return descriptors;
  };
  const descriptors = plain(record, 'Schedule record');
  const required = ['createdAt', 'firstAt', 'grant', 'intervalMs', 'nextAt', 'operation', 'principal', 'runCount', 'runs', 'scheduleId', 'schemaVersion', 'source', 'status', 'updatedAt'];
  if (Reflect.ownKeys(record).length !== required.length || required.some((key) => !Object.hasOwn(descriptors, key))) scheduleFail('AUTOMATION_SCHEDULE_RESULT_INVALID', 'Schedule record shape is invalid.', 502);
  const dense = (value, label) => {
    if (!Array.isArray(value) || nodeTypes.isProxy(value)) scheduleFail('AUTOMATION_SCHEDULE_RESULT_INVALID', `${label} are invalid.`, 502);
    const arrayDescriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key)
      || Number(key) >= value.length || !Object.hasOwn(arrayDescriptors, key) || !Object.hasOwn(arrayDescriptors[key], 'value') || arrayDescriptors[key].enumerable !== true))) {
      scheduleFail('AUTOMATION_SCHEDULE_RESULT_INVALID', `${label} are not dense data-only arrays.`, 502);
    }
    return Array.from({ length: value.length }, (_, index) => arrayDescriptors[String(index)].value);
  };
  const runs = dense(descriptors.runs.value, 'Schedule runs');
  const sourceDescriptors = plain(descriptors.source.value, 'Schedule source');
  const operationDescriptors = plain(descriptors.operation.value, 'Schedule operation');
  if (Reflect.ownKeys(sourceDescriptors).length !== 2 || !Object.hasOwn(sourceDescriptors, 'id') || !Object.hasOwn(sourceDescriptors, 'sha256')
    || Reflect.ownKeys(operationDescriptors).length !== 3 || !Object.hasOwn(operationDescriptors, 'id') || !Object.hasOwn(operationDescriptors, 'kind') || !Object.hasOwn(operationDescriptors, 'pages')) {
    scheduleFail('AUTOMATION_SCHEDULE_RESULT_INVALID', 'Schedule binding is invalid.', 502);
  }
  if (typeof sourceDescriptors.id.value !== 'string' || typeof sourceDescriptors.sha256.value !== 'string'
    || typeof operationDescriptors.id.value !== 'string' || typeof operationDescriptors.kind.value !== 'string') {
    scheduleFail('AUTOMATION_SCHEDULE_RESULT_INVALID', 'Schedule binding values are invalid.', 502);
  }
  const pages = operationDescriptors.pages.value;
  const pageValues = pages === null ? null : dense(pages, 'Schedule pages');
  if (pageValues && pageValues.some((item) => !Number.isSafeInteger(item) || item < 1 || item > 100)) scheduleFail('AUTOMATION_SCHEDULE_RESULT_INVALID', 'Schedule page values are invalid.', 502);
  const runsOut = runs.map((run) => {
    const runDescriptors = plain(run, 'Schedule run');
    const allowed = ['errorCode', 'finishedAt', 'jobId', 'occurrence', 'scheduledAt', 'startedAt', 'status'];
    if (Reflect.ownKeys(run).length !== allowed.length || allowed.some((key) => !Object.hasOwn(runDescriptors, key))) scheduleFail('AUTOMATION_SCHEDULE_RESULT_INVALID', 'Schedule run shape is invalid.', 502);
    if (typeof runDescriptors.occurrence.value !== 'string' || !Number.isSafeInteger(runDescriptors.scheduledAt.value)
      || !['admitting', 'pending', 'queued'].includes(runDescriptors.status.value)
      || (runDescriptors.jobId.value !== null && typeof runDescriptors.jobId.value !== 'string')
      || (runDescriptors.errorCode.value !== null && typeof runDescriptors.errorCode.value !== 'string')) scheduleFail('AUTOMATION_SCHEDULE_RESULT_INVALID', 'Schedule run values are invalid.', 502);
    return Object.freeze({ occurrence: runDescriptors.occurrence.value, scheduledAt: runDescriptors.scheduledAt.value, status: runDescriptors.status.value,
      jobId: runDescriptors.jobId.value ?? null, startedAt: runDescriptors.startedAt.value ?? null, finishedAt: runDescriptors.finishedAt.value ?? null,
      errorCode: runDescriptors.errorCode.value ?? null });
  });
  return Object.freeze({
    schemaVersion: AUTOMATION_SCHEDULE_SCHEMA_VERSION,
    scheduleId: descriptors.scheduleId.value,
    principal: descriptors.principal.value,
    source: Object.freeze({ id: sourceDescriptors.id.value, sha256: sourceDescriptors.sha256.value }),
    operation: Object.freeze({ id: operationDescriptors.id.value, kind: operationDescriptors.kind.value, pages: pageValues === null ? null : Object.freeze(pageValues) }),
    firstAt: descriptors.firstAt.value,
    intervalMs: descriptors.intervalMs.value,
    nextAt: descriptors.nextAt.value,
    status: descriptors.status.value,
    runCount: descriptors.runCount.value,
    runs: Object.freeze(runsOut),
    createdAt: descriptors.createdAt.value,
    updatedAt: descriptors.updatedAt.value,
  });
}
