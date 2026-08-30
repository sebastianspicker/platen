import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
  canonicalQueueJson,
  checkedQueueJobTypes,
  checkedQueueLimits,
  copyBoundedQueueJson,
  frozenQueueCopy,
  isQueueTimestamp,
  isQueueTransaction,
  normalizeQueueTransaction,
  isSafeQueueName,
  isTerminalQueueStatus,
  publicQueueJobCopy,
  queueFail,
  truncateQueueUtf8,
} from './durable-local-job-record.mjs';
import {
  validateQueueFailure,
  validateQueueIdempotencyKey,
  validateQueueRequest,
} from './durable-local-job-validation.mjs';
import {
  acquirePrivateQueueOwnership,
  preparePrivateQueueRoot,
  releasePrivateQueueOwnership,
} from './durable-local-job-storage.mjs';
import {
  emptyQueueState,
  recoverQueueClaims,
  readQueueState,
  writeQueueState,
} from './durable-local-job-journal.mjs';

export function createDurableQueueRuntime({
  root,
  clock = () => Date.now(),
  idFactory = randomUUID,
  limits,
  allowedJobTypes,
} = {}) {
  if (typeof root !== 'string' || !root) {
    queueFail('INVALID_QUEUE_ROOT', 'A queue root is required.');
  }
  if (typeof clock !== 'function' || typeof idFactory !== 'function') {
    queueFail('INVALID_QUEUE_DEPENDENCY', 'Queue clock and ID factory must be functions.');
  }
  const resolvedRoot = resolve(root);
  return {
    root: resolvedRoot,
    journalPath: join(resolvedRoot, 'journal.json'),
    clock,
    idFactory,
    limits: checkedQueueLimits(limits),
    allowedJobTypes: checkedQueueJobTypes(allowedJobTypes),
    state: null,
    mutation: Promise.resolve(),
    ownership: null,
    lastTimestamp: 0,
    closing: false,
    closed: false,
  };
}
export async function initializeQueueRuntime(runtime) {
  if (runtime.closed || runtime.closing || runtime.state || runtime.ownership) {
    queueFail('QUEUE_LIFECYCLE_INVALID', 'Queue runtime cannot be initialized again.', 409);
  }
  await preparePrivateQueueRoot(runtime.root);
  runtime.ownership = await acquirePrivateQueueOwnership(runtime.root);
  try {
    try {
      runtime.state = await readQueueState(runtime);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      runtime.state = emptyQueueState(runtime);
      await writeQueueState(runtime);
    }
    runtime.lastTimestamp = runtime.state.jobs.reduce(
      (latest, job) => Math.max(latest, job.updatedAt),
      0,
    );
    await recoverQueueClaims(runtime, now(runtime), true);
  } catch (error) {
    await releasePrivateQueueOwnership(runtime.ownership).catch(() => {});
    runtime.ownership = null;
    runtime.state = null;
    throw error;
  }
}
export function closeQueueRuntime(runtime) {
  if (runtime.closed) return Promise.resolve();
  runtime.closing = true;
  const run = runtime.mutation.then(async () => {
    try {
      await releasePrivateQueueOwnership(runtime.ownership);
    } finally {
      runtime.ownership = null;
      runtime.state = null;
      runtime.closed = true;
      runtime.closing = false;
    }
  });
  runtime.mutation = run.catch(() => {});
  return run;
}
export function enqueueQueueJob(runtime, {
  type,
  payload,
  idempotencyKey,
  transaction = null,
  maxAttempts = runtime.limits.maxAttempts,
} = {}) {
  return mutate(runtime, async () => {
    validateQueueRequest(runtime, type, idempotencyKey, maxAttempts);
    const normalizedPayload = copyBoundedQueueJson(
      payload,
      runtime.limits,
      'Job payload',
      runtime.limits.maxPayloadBytes,
    );
    const normalizedTransaction = normalizeQueueTransaction(transaction);
    if (!normalizedTransaction) {
      queueFail('INVALID_QUEUE_TRANSACTION', 'Queue transaction reference is invalid.');
    }
    const existing = runtime.state.jobs.find(
      (job) => job.idempotencyKey === idempotencyKey,
    );
    if (existing) {
      const requestMatches = existing.type === type
        && existing.maxAttempts === maxAttempts
        && canonicalQueueJson(existing.payload) === canonicalQueueJson(normalizedPayload)
        && canonicalQueueJson(existing.transaction) === canonicalQueueJson(normalizedTransaction);
      if (!requestMatches) {
        queueFail(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key belongs to a different job request.',
          409,
        );
      }
      return Object.freeze({ job: publicQueueJobCopy(existing), idempotent: true });
    }
    if (runtime.state.jobs.length >= runtime.limits.maxJobs) {
      queueFail('QUEUE_FULL', 'The durable queue is full.', 429);
    }
    const timestamp = now(runtime);
    const job = {
      schemaVersion: DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
      id: newId(runtime),
      type,
      payload: normalizedPayload,
      idempotencyKey,
      status: 'pending',
      attempts: 0,
      maxAttempts,
      createdAt: timestamp,
      updatedAt: timestamp,
      lease: null,
      retry: null,
      receipt: null,
      transaction: { source: normalizedTransaction.source, output: normalizedTransaction.output },
    };
    runtime.state.jobs.push(job);
    await writeQueueState(runtime);
    return Object.freeze({ job: publicQueueJobCopy(job), idempotent: false });
  });
}
export function recordQueueTransaction(runtime, id, leaseToken, transaction) {
  return mutate(runtime, async () => {
    if (!isQueueTransaction(transaction) || transaction === null
      || (Object.hasOwn(transaction, 'source') && Object.hasOwn(transaction, 'output'))) {
      queueFail('INVALID_QUEUE_TRANSACTION', 'Queue transaction reference is invalid.');
    }
    const job = await claimed(runtime, id, leaseToken, now(runtime));
    const slot = transaction.kind;
    if (job.transaction[slot] && canonicalQueueJson(job.transaction[slot]) !== canonicalQueueJson(transaction)) {
      queueFail('QUEUE_TRANSACTION_CONFLICT', 'Queue job already records a different transaction.', 409);
    }
    job.transaction = { ...job.transaction, [slot]: transaction };
    await writeQueueState(runtime);
    return publicQueueJobCopy(job);
  });
}
export function claimQueueJob(runtime, { workerId, leaseMs } = {}) {
  return mutate(runtime, async () => {
    if (!isSafeQueueName(workerId)) {
      queueFail('INVALID_QUEUE_WORKER', 'Worker ID must be a bounded identifier.');
    }
    if (!Number.isSafeInteger(leaseMs)
      || leaseMs < 1
      || leaseMs > runtime.limits.maxLeaseMs) {
      queueFail('INVALID_QUEUE_LEASE', 'Lease duration exceeds queue policy.');
    }
    const timestamp = now(runtime);
    await recoverQueueClaims(runtime, timestamp);
    const job = runtime.state.jobs.find(
      (item) => item.status === 'pending'
        && (!item.retry || item.retry.notBefore <= timestamp),
    );
    if (!job) return null;
    job.status = 'running';
    job.attempts += 1;
    job.updatedAt = timestamp;
    job.retry = null;
    if (timestamp > Number.MAX_SAFE_INTEGER - leaseMs) {
      queueFail('INVALID_QUEUE_CLOCK', 'Queue lease time exceeds the safe clock range.', 500);
    }
    job.lease = {
      token: newId(runtime),
      workerId,
      claimedAt: timestamp,
      expiresAt: timestamp + leaseMs,
    };
    await writeQueueState(runtime);
    return frozenQueueCopy({
      id: job.id,
      type: job.type,
      payload: job.payload,
      attempts: job.attempts,
      lease: job.lease,
      transaction: job.transaction,
    });
  });
}
export function renewQueueJob(runtime, id, leaseToken, { leaseMs } = {}) {
  return mutate(runtime, async () => {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1
      || leaseMs > runtime.limits.maxLeaseMs) {
      queueFail('INVALID_QUEUE_LEASE', 'Lease duration exceeds queue policy.');
    }
    const timestamp = now(runtime);
    const job = await claimed(runtime, id, leaseToken, timestamp);
    if (timestamp > Number.MAX_SAFE_INTEGER - leaseMs) {
      queueFail('INVALID_QUEUE_CLOCK', 'Queue lease time exceeds the safe clock range.', 500);
    }
    job.updatedAt = timestamp;
    job.lease.claimedAt = timestamp;
    job.lease.expiresAt = timestamp + leaseMs;
    await writeQueueState(runtime);
    return publicQueueJobCopy(job);
  });
}
export function completeQueueJob(runtime, id, leaseToken, result = null) {
  const normalizedResult = copyBoundedQueueJson(
    result,
    runtime.limits,
    'Job result',
    runtime.limits.maxResultBytes,
  );
  return terminal(runtime, id, leaseToken, 'completed', normalizedResult);
}
export function failQueueJob(runtime, id, leaseToken, {
  classification,
  message = 'Job failed.',
  retryNotBefore = null,
  retryDelayMs = 0,
} = {}) {
  return mutate(runtime, async () => {
    validateQueueFailure(classification, message, retryNotBefore, retryDelayMs);
    const timestamp = now(runtime);
    const job = await claimed(runtime, id, leaseToken, timestamp);
    const safeMessage = truncateQueueUtf8(message, 512);
    job.lease = null;
    job.updatedAt = timestamp;
    if (classification === 'transient' && job.attempts < job.maxAttempts) {
      if (timestamp > Number.MAX_SAFE_INTEGER - retryDelayMs) {
        queueFail('INVALID_QUEUE_CLOCK', 'Queue retry time exceeds the safe clock range.', 500);
      }
      const notBefore = retryNotBefore ?? timestamp + retryDelayMs;
      if (!isQueueTimestamp(notBefore) || notBefore < timestamp) {
        queueFail('INVALID_QUEUE_BACKOFF', 'Retry time must be a future clock value.');
      }
      job.status = 'pending';
      job.retry = { classification, notBefore, message: safeMessage };
    } else {
      makeTerminal(
        job,
        'failed',
        null,
        { classification, message: safeMessage },
        timestamp,
      );
    }
    await writeQueueState(runtime);
    return publicQueueJobCopy(job);
  });
}
export function cancelQueueJob(runtime, id) {
  return mutate(runtime, async () => {
    const job = findJob(runtime, id);
    if (isTerminalQueueStatus(job.status)) return publicQueueJobCopy(job);
    makeTerminal(job, 'cancelled', null, null, now(runtime));
    await writeQueueState(runtime);
    return publicQueueJobCopy(job);
  });
}
export async function getQueueJob(runtime, id) {
  await runtime.mutation;
  requireInitialized(runtime);
  return publicQueueJobCopy(findJob(runtime, id));
}
export async function readQueueJobReceipt(runtime, id) {
  const job = await getQueueJob(runtime, id);
  return job.receipt ? frozenQueueCopy(job.receipt) : null;
}
export async function inspectQueueAdmission(runtime, idempotencyKey) {
  await runtime.mutation;
  requireInitialized(runtime);
  validateQueueIdempotencyKey(runtime, idempotencyKey);
  const existing = runtime.state.jobs.find((job) => job.idempotencyKey === idempotencyKey);
  return Object.freeze({
    accepting: existing !== undefined || runtime.state.jobs.length < runtime.limits.maxJobs,
    existing: existing ? publicQueueJobCopy(existing) : null,
  });
}
function requireInitialized(runtime) {
  if (!runtime.state || !runtime.ownership || runtime.closing || runtime.closed) {
    queueFail('QUEUE_NOT_INITIALIZED', 'Initialize the queue before use.', 500);
  }
}
function now(runtime) {
  const observed = runtime.clock();
  if (!isQueueTimestamp(observed)) {
    queueFail('INVALID_QUEUE_CLOCK', 'Queue clock must return a non-negative integer.', 500);
  }
  const timestamp = Math.max(observed, runtime.lastTimestamp);
  runtime.lastTimestamp = timestamp;
  return timestamp;
}
function newId(runtime) {
  const id = runtime.idFactory();
  const conflicts = runtime.state?.jobs.some(
    (job) => job.id === id || job.lease?.token === id,
  );
  if (!isSafeQueueName(id) || conflicts) {
    queueFail(
      'INVALID_QUEUE_ID',
      'Queue ID factory returned an unsafe or duplicate identifier.',
      500,
    );
  }
  return id;
}
function findJob(runtime, id) {
  if (!isSafeQueueName(id)) queueFail('INVALID_QUEUE_JOB_ID', 'Job ID is invalid.');
  const job = runtime.state.jobs.find((item) => item.id === id);
  if (!job) queueFail('QUEUE_JOB_NOT_FOUND', 'Queue job was not found.', 404);
  return job;
}
async function claimed(runtime, id, token, timestamp) {
  const job = findJob(runtime, id);
  if (job.status === 'running' && job.lease?.expiresAt <= timestamp) {
    await recoverQueueClaims(runtime, timestamp);
  }
  if (job.status !== 'running' || !job.lease || token !== job.lease.token) {
    queueFail('QUEUE_LEASE_CONFLICT', 'Queue job is not claimed by this lease.', 409);
  }
  return job;
}
function makeTerminal(job, status, result, error, timestamp) {
  job.status = status;
  job.updatedAt = timestamp;
  job.lease = null;
  job.retry = null;
  job.receipt = {
    schemaVersion: DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
    status,
    finishedAt: timestamp,
    result,
    error,
  };
}
function terminal(runtime, id, token, status, result) {
  return mutate(runtime, async () => {
    const timestamp = now(runtime);
    const job = await claimed(runtime, id, token, timestamp);
    makeTerminal(job, status, result, null, timestamp);
    await writeQueueState(runtime);
    return publicQueueJobCopy(job);
  });
}

function mutate(runtime, operation) {
  const run = runtime.mutation.then(async () => {
    requireInitialized(runtime);
    const snapshot = JSON.parse(canonicalQueueJson(runtime.state));
    try {
      return await operation();
    } catch (error) {
      try {
        runtime.state = await readQueueState(runtime);
      } catch {
        runtime.state = snapshot;
      }
      throw error;
    }
  });
  runtime.mutation = run.catch(() => {});
  return run;
}
