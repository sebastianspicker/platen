import { HostError } from '../host-error.mjs';

export const DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION = 1;

export const DEFAULT_DURABLE_LOCAL_JOB_QUEUE_LIMITS = Object.freeze({
  maxJobs: 256,
  maxPayloadBytes: 64 * 1024,
  maxResultBytes: 64 * 1024,
  maxRecordBytes: 128 * 1024,
  maxJsonDepth: 8,
  maxJsonItems: 10_000,
  maxIdempotencyKeyBytes: 256,
  maxLeaseMs: 10 * 60 * 1000,
  maxAttempts: 8,
});

const JOB_KEYS = Object.freeze([
  'attempts',
  'createdAt',
  'id',
  'idempotencyKey',
  'lease',
  'maxAttempts',
  'payload',
  'receipt',
  'retry',
  'schemaVersion',
  'status',
  'transaction',
  'type',
  'updatedAt',
]);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const UNSAFE_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_DURABLE_LOCAL_JOB_QUEUE_LIMITS).sort());
const MAXIMUM_QUEUE_LIMITS = Object.freeze({
  maxJobs: 1_024,
  maxPayloadBytes: 256 * 1024,
  maxResultBytes: 256 * 1024,
  maxRecordBytes: 1024 * 1024,
  maxJsonDepth: 32,
  maxJsonItems: 100_000,
  maxIdempotencyKeyBytes: 1_024,
  maxLeaseMs: 24 * 60 * 60 * 1000,
  maxAttempts: 32,
});
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;

export function isQueueTransaction(value) {
  if (value === null) return true;
  if (isPlainObject(value) && Object.keys(value).sort().join(',') === 'output,source') {
    return (value.source === null || isQueueTransactionRef(value.source, 'source'))
      && (value.output === null || isQueueTransactionRef(value.output, 'output'));
  }
  return isQueueTransactionRef(value);
}

function isQueueTransactionRef(value, expectedKind = null) {
  if (!isPlainObject(value)
    || Object.keys(value).sort().join(',') !== 'id,kind,sha256,size,sourceId,sourceSha256'
    || !['source', 'output'].includes(value.kind)
    || (expectedKind && value.kind !== expectedKind)
    || !isSafeQueueName(value.id)
    || !isSafeQueueName(value.sourceId)
    || !SHA256.test(value.sha256)
    || !SHA256.test(value.sourceSha256)
    || !Number.isSafeInteger(value.size) || value.size < 5 || value.size > 512 * 1024 * 1024) {
    return false;
  }
  return true;
}

export function normalizeQueueTransaction(value) {
  if (value === null) return Object.freeze({ source: null, output: null });
  if (isPlainObject(value) && Object.keys(value).sort().join(',') === 'output,source') {
    if (!isQueueTransaction(value)) return null;
    return frozenQueueCopy({ source: value.source ?? null, output: value.output ?? null });
  }
  if (!isQueueTransactionRef(value)) return null;
  return frozenQueueCopy({ source: value.kind === 'source' ? value : null, output: value.kind === 'output' ? value : null });
}

const SHA256 = /^[a-f0-9]{64}$/u;

export function queueFail(code, message, status = 400, cause) {
  throw new HostError(code, message, status, cause ? { cause } : undefined);
}

export function isSafeQueueName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function isQueueTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value) {
  return value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && actual.every((key, index) => key === keys[index]);
}

export function canonicalQueueJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      queueFail('INVALID_QUEUE_RECORD', 'Queue values must be finite JSON values.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalQueueJson).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    queueFail('INVALID_QUEUE_RECORD', 'Queue values must be plain JSON objects.');
  }
  const keys = Object.keys(value);
  if (keys.some((key) => UNSAFE_JSON_KEYS.has(key))) {
    queueFail('INVALID_QUEUE_RECORD', 'Queue values contain an unsafe JSON key.');
  }
  const fields = keys
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalQueueJson(value[key])}`);
  return `{${fields.join(',')}}`;
}

export function frozenQueueCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenQueueCopy));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, frozenQueueCopy(item)]),
    ));
  }
  return value;
}

export function publicQueueJobCopy(job) {
  const lease = job.lease
    ? {
      workerId: job.lease.workerId,
      claimedAt: job.lease.claimedAt,
      expiresAt: job.lease.expiresAt,
    }
    : null;
  return frozenQueueCopy({ ...job, lease });
}

export function truncateQueueUtf8(value, maximumBytes) {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  let result = '';
  let size = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (size + characterBytes > maximumBytes) break;
    result += character;
    size += characterBytes;
  }
  return result;
}

export function copyBoundedQueueJson(value, limits, label, maximumBytes) {
  let items = 0;
  function visit(item, depth = 0) {
    items += 1;
    if (items > limits.maxJsonItems) {
      queueFail('QUEUE_PAYLOAD_TOO_LARGE', `${label} exceeds the queue item limit.`, 413);
    }
    if (depth > limits.maxJsonDepth) {
      queueFail('QUEUE_PAYLOAD_TOO_DEEP', `${label} exceeds the queue JSON depth limit.`, 413);
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) queueFail('INVALID_QUEUE_RECORD', `${label} is not JSON.`);
      return;
    }
    if (Array.isArray(item)) {
      const keys = Object.keys(item);
      if (keys.length !== item.length
        || keys.some((key, index) => key !== String(index))) {
        queueFail('INVALID_QUEUE_RECORD', `${label} contains a sparse or extended array.`);
      }
      item.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (!isPlainObject(item)
      || Object.keys(item).some((key) => UNSAFE_JSON_KEYS.has(key))) {
      queueFail('INVALID_QUEUE_RECORD', `${label} is not a safe JSON value.`);
    }
    Object.values(item).forEach((entry) => visit(entry, depth + 1));
  }

  visit(value);
  const text = canonicalQueueJson(value);
  if (Buffer.byteLength(text) > maximumBytes) {
    queueFail('QUEUE_PAYLOAD_TOO_LARGE', `${label} exceeds the queue payload limit.`, 413);
  }
  return JSON.parse(text);
}

export function checkedQueueLimits(input = {}) {
  if (!isPlainObject(input)
    || Object.keys(input).some((key) => !LIMIT_KEYS.includes(key))) {
    queueFail('INVALID_QUEUE_LIMITS', 'Queue limits contain an unsupported field.');
  }
  const limits = { ...DEFAULT_DURABLE_LOCAL_JOB_QUEUE_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_QUEUE_LIMITS[key]) {
      queueFail('INVALID_QUEUE_LIMITS', `Queue limit ${key} is outside the fixed safety bound.`);
    }
  }
  if (limits.maxPayloadBytes > limits.maxRecordBytes
    || limits.maxResultBytes > limits.maxRecordBytes
    || limits.maxJobs * limits.maxRecordBytes > MAX_JOURNAL_BYTES) {
    queueFail('INVALID_QUEUE_LIMITS', 'Queue limits exceed the aggregate journal policy.');
  }
  return Object.freeze(limits);
}

export function checkedQueueJobTypes(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64
    || input.some((type) => !isSafeQueueName(type))
    || new Set(input).size !== input.length) {
    queueFail(
      'INVALID_QUEUE_JOB_TYPES',
      'Queue job types must be a non-empty unique bounded allowlist.',
    );
  }
  return Object.freeze([...input].sort());
}

export function queuePolicySnapshot(allowedJobTypes, limits) {
  return Object.freeze({
    allowedJobTypes: Object.freeze([...allowedJobTypes]),
    limits: Object.freeze(Object.fromEntries(
      LIMIT_KEYS.map((key) => [key, limits[key]]),
    )),
  });
}

function validateCommonJobFields(job, limits) {
  if (!hasExactKeys(job, JOB_KEYS)
    || job.schemaVersion !== DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION
    || !isSafeQueueName(job.id)
    || !isSafeQueueName(job.type)
    || typeof job.idempotencyKey !== 'string'
    || !job.idempotencyKey
    || Buffer.byteLength(job.idempotencyKey) > limits.maxIdempotencyKeyBytes
    || !Number.isSafeInteger(job.attempts)
    || !Number.isSafeInteger(job.maxAttempts)
    || job.attempts < 0
    || job.attempts > job.maxAttempts
    || job.maxAttempts < 1
    || job.maxAttempts > limits.maxAttempts
    || !isQueueTimestamp(job.createdAt)
    || !isQueueTimestamp(job.updatedAt)
    || job.updatedAt < job.createdAt) {
    throw new TypeError('Invalid common queue job fields.');
  }
  if (!isQueueTransaction(job.transaction)) throw new TypeError('Invalid queue transaction.');
  copyBoundedQueueJson(job.payload, limits, 'Journal payload', limits.maxPayloadBytes);
  if (Buffer.byteLength(canonicalQueueJson(job)) > limits.maxRecordBytes) {
    throw new TypeError('Queue job exceeds the record limit.');
  }
}

function validatePendingJob(job) {
  if (job.lease !== null || job.receipt !== null) throw new TypeError('Invalid pending job.');
  if (job.retry === null) {
    if (job.attempts !== 0) throw new TypeError('Retried pending job lacks retry evidence.');
    return;
  }
  if (job.attempts < 1
    || !hasExactKeys(job.retry, ['classification', 'message', 'notBefore'])
    || !['transient', 'interrupted'].includes(job.retry.classification)
    || !isQueueTimestamp(job.retry.notBefore)
    || job.retry.notBefore < job.updatedAt
    || typeof job.retry.message !== 'string'
    || Buffer.byteLength(job.retry.message) > 512) {
    throw new TypeError('Invalid pending retry evidence.');
  }
}

function validateRunningJob(job, limits) {
  if (job.attempts < 1
    || job.retry !== null
    || job.receipt !== null
    || !hasExactKeys(job.lease, ['claimedAt', 'expiresAt', 'token', 'workerId'])
    || !isSafeQueueName(job.lease.token)
    || !isSafeQueueName(job.lease.workerId)
    || !isQueueTimestamp(job.lease.claimedAt)
    || !isQueueTimestamp(job.lease.expiresAt)
    || job.lease.claimedAt !== job.updatedAt
    || job.lease.expiresAt <= job.lease.claimedAt
    || job.lease.expiresAt - job.lease.claimedAt > limits.maxLeaseMs) {
    throw new TypeError('Invalid running job.');
  }
}

function validateTerminalJob(job, limits) {
  if (job.lease !== null
    || job.retry !== null
    || !hasExactKeys(job.receipt, [
      'error', 'finishedAt', 'result', 'schemaVersion', 'status',
    ])
    || job.receipt.schemaVersion !== DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION
    || job.receipt.status !== job.status
    || !isQueueTimestamp(job.receipt.finishedAt)
    || job.receipt.finishedAt !== job.updatedAt) {
    throw new TypeError('Invalid terminal receipt.');
  }
  if (job.status === 'completed') {
    if (job.attempts < 1 || job.receipt.error !== null) {
      throw new TypeError('Invalid completion receipt.');
    }
    copyBoundedQueueJson(
      job.receipt.result,
      limits,
      'Journal result',
      limits.maxResultBytes,
    );
    return;
  }
  if (job.receipt.result !== null) throw new TypeError('Invalid terminal result.');
  if (job.status === 'cancelled') {
    if (job.receipt.error !== null) throw new TypeError('Invalid cancellation receipt.');
    return;
  }
  if (job.attempts < 1
    || !hasExactKeys(job.receipt.error, ['classification', 'message'])
    || !['transient', 'permanent', 'interrupted'].includes(
      job.receipt.error.classification,
    )
    || typeof job.receipt.error.message !== 'string'
    || Buffer.byteLength(job.receipt.error.message) > 512) {
    throw new TypeError('Invalid failure receipt.');
  }
}

function validateJob(job, limits) {
  validateCommonJobFields(job, limits);
  if (job.status === 'pending') return validatePendingJob(job);
  if (job.status === 'running') return validateRunningJob(job, limits);
  if (TERMINAL_STATUSES.has(job.status)) return validateTerminalJob(job, limits);
  throw new TypeError('Invalid queue job status.');
}

export function validateQueueState(state, limits, allowedJobTypes) {
  if (!hasExactKeys(state, ['jobs', 'policy', 'schemaVersion'])
    || state.schemaVersion !== DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION
    || !Array.isArray(state.jobs)
    || state.jobs.length > limits.maxJobs) {
    queueFail('QUEUE_JOURNAL_CORRUPT', 'Queue journal is corrupt.', 500);
  }
  const expectedPolicy = queuePolicySnapshot(allowedJobTypes, limits);
  if (canonicalQueueJson(state.policy) !== canonicalQueueJson(expectedPolicy)) {
    queueFail(
      'QUEUE_POLICY_MISMATCH',
      'Queue journal policy does not match the configured runtime.',
      500,
    );
  }

  const identifiers = new Set();
  const idempotencyKeys = new Set();
  try {
    for (const job of state.jobs) {
      validateJob(job, limits);
      if (!allowedJobTypes.includes(job.type)) {
        throw new TypeError('Queue job type is outside the persisted allowlist.');
      }
      if (identifiers.has(job.id) || idempotencyKeys.has(job.idempotencyKey)) {
        throw new TypeError('Duplicate queue identifier.');
      }
      identifiers.add(job.id);
      idempotencyKeys.add(job.idempotencyKey);
    }
    for (const job of state.jobs) {
      if (!job.lease) continue;
      if (identifiers.has(job.lease.token)) throw new TypeError('Duplicate lease token.');
      identifiers.add(job.lease.token);
    }
  } catch {
    queueFail('QUEUE_JOURNAL_CORRUPT', 'Queue journal job record is invalid.', 500);
  }
}

export function isTerminalQueueStatus(status) {
  return TERMINAL_STATUSES.has(status);
}
