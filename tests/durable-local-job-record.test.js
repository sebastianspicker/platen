import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_DURABLE_LOCAL_JOB_QUEUE_LIMITS,
  DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
  canonicalQueueJson,
  checkedQueueLimits,
  copyBoundedQueueJson,
  frozenQueueCopy,
  queuePolicySnapshot,
  validateQueueState,
} from '../scripts/host/automation/durable-local-job-record.mjs';

const limits = checkedQueueLimits();
const allowedJobTypes = ['pdf_review'];

function pendingJob(overrides = {}) {
  return {
    attempts: 0,
    createdAt: 1,
    id: 'job_1',
    idempotencyKey: 'request_1',
    lease: null,
    maxAttempts: 3,
    payload: {},
    receipt: null,
    retry: null,
    schemaVersion: DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
    status: 'pending',
    transaction: null,
    type: 'pdf_review',
    updatedAt: 1,
    ...overrides,
  };
}

function queueState(jobs) {
  return {
    jobs,
    policy: queuePolicySnapshot(allowedJobTypes, limits),
    schemaVersion: DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
  };
}

function expectHostError(code, status) {
  return (error) => error?.code === code && error.status === status;
}

test('canonical queue JSON is sorted and rejects unsafe JSON inputs', () => {
  assert.equal(canonicalQueueJson({ b: 'text', a: [true, 2] }), '{"a":[true,2],"b":"text"}');
  assert.throws(
    () => canonicalQueueJson(Number.NaN),
    expectHostError('INVALID_QUEUE_RECORD', 400),
  );
  assert.throws(
    () => canonicalQueueJson(Object.create(null)),
    expectHostError('INVALID_QUEUE_RECORD', 400),
  );
  assert.throws(
    () => canonicalQueueJson(JSON.parse('{"__proto__":true}')),
    expectHostError('INVALID_QUEUE_RECORD', 400),
  );

  const hostileAccessor = {};
  Object.defineProperty(hostileAccessor, 'value', {
    enumerable: true,
    get() { throw new Error('hostile accessor'); },
  });
  assert.throws(() => canonicalQueueJson(hostileAccessor), /hostile accessor/u);
});

test('bounded queue JSON copies canonical data and preserves its hard limits', () => {
  const source = { b: [true], a: { value: 1 } };
  const copied = copyBoundedQueueJson(source, limits, 'Payload', 128);
  assert.deepEqual(copied, { a: { value: 1 }, b: [true] });
  assert.notEqual(copied, source);
  assert.notEqual(copied.a, source.a);
  assert.throws(
    () => copyBoundedQueueJson([1, 2], limits, 'Payload', 3),
    expectHostError('QUEUE_PAYLOAD_TOO_LARGE', 413),
  );
  assert.throws(
    () => copyBoundedQueueJson({ a: { b: {} } }, { ...limits, maxJsonDepth: 1 }, 'Payload', 128),
    expectHostError('QUEUE_PAYLOAD_TOO_DEEP', 413),
  );
  assert.throws(
    () => copyBoundedQueueJson([1, 2], { ...limits, maxJsonItems: 2 }, 'Payload', 128),
    expectHostError('QUEUE_PAYLOAD_TOO_LARGE', 413),
  );

  const sparse = [];
  sparse[1] = true;
  assert.throws(
    () => copyBoundedQueueJson(sparse, limits, 'Payload', 128),
    expectHostError('INVALID_QUEUE_RECORD', 400),
  );
  assert.throws(
    () => copyBoundedQueueJson(JSON.parse('{"constructor":true}'), limits, 'Payload', 128),
    expectHostError('INVALID_QUEUE_RECORD', 400),
  );
});

test('frozen queue copies are recursively immutable and detached from their input', () => {
  const source = { nested: { values: [1] } };
  const copied = frozenQueueCopy(source);
  source.nested.values.push(2);

  assert.deepEqual(copied, { nested: { values: [1] } });
  assert.equal(Object.isFrozen(copied), true);
  assert.equal(Object.isFrozen(copied.nested), true);
  assert.equal(Object.isFrozen(copied.nested.values), true);
});

test('queue state accepts valid pending, running, and terminal job invariants', () => {
  const running = pendingJob({
    attempts: 1,
    id: 'job_2',
    idempotencyKey: 'request_2',
    lease: { claimedAt: 5, expiresAt: 10, token: 'lease_2', workerId: 'worker_2' },
    status: 'running',
    updatedAt: 5,
  });
  const completed = pendingJob({
    attempts: 1,
    id: 'job_3',
    idempotencyKey: 'request_3',
    receipt: {
      error: null,
      finishedAt: 7,
      result: { answer: 42 },
      schemaVersion: DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
      status: 'completed',
    },
    status: 'completed',
    updatedAt: 7,
  });
  const failed = pendingJob({
    attempts: 1,
    id: 'job_4',
    idempotencyKey: 'request_4',
    receipt: {
      error: { classification: 'permanent', message: 'failed' },
      finishedAt: 8,
      result: null,
      schemaVersion: DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
      status: 'failed',
    },
    status: 'failed',
    updatedAt: 8,
  });

  assert.doesNotThrow(() => validateQueueState(queueState([
    pendingJob(), running, completed, failed,
  ]), limits, allowedJobTypes));
});

test('queue state maps invalid job invariants and policy mismatches to existing host errors', () => {
  const invalidRunning = pendingJob({
    attempts: 0,
    lease: { claimedAt: 1, expiresAt: 2, token: 'lease_1', workerId: 'worker_1' },
    status: 'running',
  });
  assert.throws(
    () => validateQueueState(queueState([invalidRunning]), limits, allowedJobTypes),
    expectHostError('QUEUE_JOURNAL_CORRUPT', 500),
  );

  const invalidTerminal = pendingJob({
    attempts: 1,
    receipt: {
      error: {},
      finishedAt: 1,
      result: null,
      schemaVersion: DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
      status: 'completed',
    },
    status: 'completed',
  });
  assert.throws(
    () => validateQueueState(queueState([invalidTerminal]), limits, allowedJobTypes),
    expectHostError('QUEUE_JOURNAL_CORRUPT', 500),
  );

  const policyMismatch = {
    ...queueState([]),
    policy: { ...queuePolicySnapshot(allowedJobTypes, limits), allowedJobTypes: ['other'] },
  };
  assert.throws(
    () => validateQueueState(policyMismatch, limits, allowedJobTypes),
    expectHostError('QUEUE_POLICY_MISMATCH', 500),
  );
});

test('queue limit validation retains fixed bounds and immutable defaults', () => {
  assert.equal(Object.isFrozen(limits), true);
  assert.deepEqual(limits, DEFAULT_DURABLE_LOCAL_JOB_QUEUE_LIMITS);
  assert.throws(
    () => checkedQueueLimits({ maxJobs: 1_025 }),
    expectHostError('INVALID_QUEUE_LIMITS', 400),
  );
  assert.throws(
    () => checkedQueueLimits({ maxPayloadBytes: 129 * 1024, maxRecordBytes: 128 * 1024 }),
    expectHostError('INVALID_QUEUE_LIMITS', 400),
  );
});
