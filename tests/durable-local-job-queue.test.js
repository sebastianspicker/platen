import assert from 'node:assert/strict';
import { chmod, link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableLocalJobQueue } from '../scripts/host/automation/durable-local-job-queue.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-queue-'));
  let now = 1_000;
  let sequence = 0;
  const queueRoot = join(root, 'queue');
  const allowedJobTypes = ['pdf_review'];
  const queue = new DurableLocalJobQueue({
    root: queueRoot,
    clock: () => now,
    idFactory: () => `id_${++sequence}`,
    allowedJobTypes,
    ...options,
  });
  await queue.initialize();
  t.after(async () => {
    await queue.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    queue,
    advance: (milliseconds) => { now += milliseconds; },
    setTime: (value) => { now = value; },
    options: {
      root: queueRoot,
      clock: () => now,
      idFactory: () => `restart_${++sequence}`,
      allowedJobTypes,
      ...options,
    },
  };
}

test('queue persists canonical jobs, idempotency, and frozen receipts', async (t) => {
  const { queue, options } = await fixture(t);
  const first = await queue.enqueue({
    type: 'pdf_review',
    payload: { b: 2, a: [true] },
    idempotencyKey: 'request-1',
  });
  const repeat = await queue.enqueue({
    type: 'pdf_review',
    payload: { a: [true], b: 2 },
    idempotencyKey: 'request-1',
  });
  assert.equal(first.idempotent, false);
  assert.equal(repeat.idempotent, true);
  assert.equal(repeat.job.id, first.job.id);

  const claim = await queue.claim({ workerId: 'worker_1', leaseMs: 100 });
  assert.deepEqual(claim.payload, { a: [true], b: 2 });
  assert.equal(Object.hasOwn((await queue.get(claim.id)).lease, 'token'), false);
  const completed = await queue.complete(claim.id, claim.lease.token, { answer: 42 });
  assert.equal(completed.status, 'completed');
  assert.equal(Object.isFrozen(completed), true);
  assert.equal(Object.isFrozen(completed.receipt), true);

  await queue.close();
  const reloaded = await new DurableLocalJobQueue(options).initialize();
  t.after(() => reloaded.close().catch(() => {}));
  assert.deepEqual(await reloaded.receipt(claim.id), {
    schemaVersion: 1,
    status: 'completed',
    finishedAt: 1000,
    result: { answer: 42 },
    error: null,
  });
  const journal = await readFile(join(options.root, 'journal.json'), 'utf8');
  assert.equal(journal.startsWith('{"jobs":['), true);
});

test('queue exposes bounded admission evidence and renews the same lease token', async (t) => {
  const { queue, advance } = await fixture(t, { limits: { maxJobs: 1 } });
  assert.deepEqual(await queue.admission('first'), { accepting: true, existing: null });
  const { job } = await queue.enqueue({
    type: 'pdf_review', payload: {}, idempotencyKey: 'first',
  });
  assert.equal((await queue.admission('first')).existing.id, job.id);
  assert.deepEqual(await queue.admission('second'), { accepting: false, existing: null });
  const claim = await queue.claim({ workerId: 'worker_1', leaseMs: 100 });
  advance(50);
  const renewed = await queue.renew(claim.id, claim.lease.token, { leaseMs: 100 });
  assert.equal(renewed.lease.claimedAt, 1050);
  assert.equal(renewed.lease.expiresAt, 1150);
  advance(80);
  assert.equal((await queue.complete(claim.id, claim.lease.token, {})).status, 'completed');
});

test('restart recovers interrupted claims and explicit transient backoff controls eligibility', async (t) => {
  const { queue, options, advance } = await fixture(t);
  const { job } = await queue.enqueue({
    type: 'pdf_review',
    payload: {},
    idempotencyKey: 'request-2',
    maxAttempts: 3,
  });
  const first = await queue.claim({ workerId: 'worker_1', leaseMs: 100 });
  await queue.close();
  const restarted = await new DurableLocalJobQueue(options).initialize();
  t.after(() => restarted.close().catch(() => {}));
  assert.equal((await restarted.get(job.id)).status, 'pending');
  const recovered = await restarted.claim({ workerId: 'worker_2', leaseMs: 100 });
  await restarted.fail(recovered.id, recovered.lease.token, {
    classification: 'transient',
    message: 'busy',
    retryNotBefore: 2000,
  });
  assert.equal(await restarted.claim({ workerId: 'worker_2', leaseMs: 100 }), null);
  advance(1000);
  const retried = await restarted.claim({ workerId: 'worker_2', leaseMs: 100 });
  assert.equal(retried.attempts, 3);
  const failed = await restarted.fail(retried.id, retried.lease.token, {
    classification: 'transient',
    message: 'still busy',
  });
  assert.equal(failed.status, 'failed');
  assert.equal((await restarted.receipt(job.id)).error.classification, 'transient');
  assert.equal(first.id, job.id);
});

test('queue fails closed for unsafe or corrupt persistence and supports cancellation', async (t) => {
  const { root, queue, options } = await fixture(t);
  const { job } = await queue.enqueue({ type: 'pdf_review', payload: {}, idempotencyKey: 'request-3' });
  assert.equal((await queue.cancel(job.id)).status, 'cancelled');
  await queue.close();
  const journal = join(options.root, 'journal.json');
  await writeFile(journal, '{"schemaVersion":1,"jobs":[]}');
  await assert.rejects(
    new DurableLocalJobQueue(options).initialize(),
    { code: 'QUEUE_JOURNAL_CORRUPT' },
  );

  await rm(journal);
  await writeFile(join(root, 'outside'), 'x');
  await symlink(join(root, 'outside'), journal);
  await assert.rejects(
    new DurableLocalJobQueue(options).initialize(),
    { code: 'QUEUE_STORAGE_UNSAFE' },
  );

  await rm(journal);
  await writeFile(journal, '{"jobs":[],"schemaVersion":1}');
  await link(journal, join(root, 'journal-link'));
  await assert.rejects(
    new DurableLocalJobQueue(options).initialize(),
    { code: 'QUEUE_STORAGE_UNSAFE' },
  );
  await chmod(options.root, 0o700);
  await mkdir(join(options.root, 'ignored'), { recursive: true });
});

test('queue rejects request conflicts, unsafe JSON, duplicate IDs, and invalid journals', async (t) => {
  const { queue, options } = await fixture(t);
  await queue.enqueue({
    type: 'pdf_review',
    payload: { a: 1 },
    idempotencyKey: 'request-4',
  });
  await assert.rejects(queue.enqueue({
    type: 'pdf_review',
    payload: { a: 2 },
    idempotencyKey: 'request-4',
  }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(queue.enqueue({
    type: 'pdf_review',
    payload: JSON.parse('{"__proto__":true}'),
    idempotencyKey: 'request-5',
  }), { code: 'INVALID_QUEUE_RECORD' });

  const duplicate = new DurableLocalJobQueue({
    root: join(options.root, 'duplicate'),
    clock: () => 1,
    idFactory: () => 'same_id',
    allowedJobTypes: ['pdf_review'],
  });
  await duplicate.initialize();
  t.after(() => duplicate.close().catch(() => {}));
  await duplicate.enqueue({ type: 'pdf_review', payload: {}, idempotencyKey: 'first' });
  await assert.rejects(duplicate.enqueue({
    type: 'pdf_review',
    payload: {},
    idempotencyKey: 'second',
  }), { code: 'INVALID_QUEUE_ID' });
  await queue.close();
  await writeFile(join(options.root, 'journal.json'), '{"jobs":[{"schemaVersion":1}],"schemaVersion":1}');
  await assert.rejects(
    new DurableLocalJobQueue(options).initialize(),
    { code: 'QUEUE_JOURNAL_CORRUPT' },
  );
});

test('claim recovers an expired lease without a restart', async (t) => {
  const { queue, advance } = await fixture(t);
  await queue.enqueue({ type: 'pdf_review', payload: {}, idempotencyKey: 'request-6', maxAttempts: 2 });
  const first = await queue.claim({ workerId: 'worker_1', leaseMs: 10 });
  advance(10);
  const recovered = await queue.claim({ workerId: 'worker_2', leaseMs: 10 });
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.attempts, 2);
});

test('expired leases cannot complete and are durably returned to pending', async (t) => {
  const { queue, advance, options } = await fixture(t);
  await queue.enqueue({
    type: 'pdf_review',
    payload: {},
    idempotencyKey: 'request-7',
    maxAttempts: 2,
  });
  const claim = await queue.claim({ workerId: 'worker_1', leaseMs: 10 });
  advance(10);

  await assert.rejects(
    queue.complete(claim.id, claim.lease.token, { ignored: true }),
    { code: 'QUEUE_LEASE_CONFLICT' },
  );
  assert.equal((await queue.get(claim.id)).status, 'pending');

  await queue.close();
  const reloaded = await new DurableLocalJobQueue(options).initialize();
  t.after(() => reloaded.close().catch(() => {}));
  assert.equal((await reloaded.get(claim.id)).status, 'pending');
});

test('operations fail explicitly before queue initialization', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-queue-uninitialized-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new DurableLocalJobQueue({
    root: join(root, 'queue'),
    allowedJobTypes: ['pdf_review'],
  });

  await assert.rejects(
    queue.enqueue({ type: 'pdf_review', payload: {}, idempotencyKey: 'request-8' }),
    { code: 'QUEUE_NOT_INITIALIZED' },
  );
  await assert.rejects(queue.get('job_1'), { code: 'QUEUE_NOT_INITIALIZED' });
});

test('one live owner prevents lost updates and duplicate execution', async (t) => {
  const { queue, options } = await fixture(t);
  const second = new DurableLocalJobQueue(options);
  await assert.rejects(second.initialize(), { code: 'QUEUE_ALREADY_OPEN' });

  const { job } = await queue.enqueue({
    type: 'pdf_review',
    payload: {},
    idempotencyKey: 'request-9',
  });
  const claim = await queue.claim({ workerId: 'worker_1', leaseMs: 600_000 });
  await assert.rejects(second.initialize(), { code: 'QUEUE_ALREADY_OPEN' });
  assert.equal(claim.id, job.id);

  await queue.close();
  const restarted = await new DurableLocalJobQueue(options).initialize();
  t.after(() => restarted.close().catch(() => {}));
  assert.equal((await restarted.get(job.id)).status, 'pending');
});

test('queue persists bounded UTF-8 failures and survives wall-clock rollback', async (t) => {
  const { queue, options, setTime } = await fixture(t);
  const { job } = await queue.enqueue({
    type: 'pdf_review',
    payload: {},
    idempotencyKey: 'request-10',
    maxAttempts: 2,
  });
  setTime(900);
  const first = await queue.claim({ workerId: 'worker_1', leaseMs: 10 });
  assert.equal(first.lease.claimedAt, 1000);
  const retry = await queue.fail(first.id, first.lease.token, {
    classification: 'transient',
    message: '😀'.repeat(512),
  });
  assert.ok(Buffer.byteLength(retry.retry.message) <= 512);

  const second = await queue.claim({ workerId: 'worker_2', leaseMs: 10 });
  const failed = await queue.fail(second.id, second.lease.token, {
    classification: 'permanent',
    message: '😀'.repeat(512),
  });
  assert.ok(Buffer.byteLength(failed.receipt.error.message) <= 512);
  await queue.close();

  const reloaded = await new DurableLocalJobQueue(options).initialize();
  t.after(() => reloaded.close().catch(() => {}));
  assert.equal((await reloaded.get(job.id)).status, 'failed');
});

test('queue binds its durable journal to an exact job-type and limit policy', async (t) => {
  const { queue, options } = await fixture(t);
  await assert.rejects(queue.enqueue({
    type: 'unapproved_job',
    payload: {},
    idempotencyKey: 'request-11',
  }), { code: 'INVALID_QUEUE_JOB_TYPE' });
  const sparse = [];
  sparse.length = 2;
  await assert.rejects(queue.enqueue({
    type: 'pdf_review',
    payload: sparse,
    idempotencyKey: 'request-12',
  }), { code: 'INVALID_QUEUE_RECORD' });
  await queue.close();

  const changedPolicy = new DurableLocalJobQueue({
    ...options,
    allowedJobTypes: ['different_job'],
  });
  await assert.rejects(changedPolicy.initialize(), { code: 'QUEUE_POLICY_MISMATCH' });
  assert.throws(() => new DurableLocalJobQueue({
    root: join(options.root, 'oversized-policy'),
    allowedJobTypes: ['pdf_review'],
    limits: { maxJobs: 1_024, maxRecordBytes: 1024 * 1024 },
  }), { code: 'INVALID_QUEUE_LIMITS' });
});

test('an unclean ownership lock fails closed until explicitly recovered', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-queue-stale-owner-'));
  const queueRoot = join(root, 'queue');
  await mkdir(queueRoot, { mode: 0o700 });
  await writeFile(join(queueRoot, '.owner.lock'), '{"pid":1,"schemaVersion":1}');
  t.after(() => rm(root, { recursive: true, force: true }));

  const blocked = new DurableLocalJobQueue({
    root: queueRoot,
    allowedJobTypes: ['pdf_review'],
  });
  await assert.rejects(blocked.initialize(), { code: 'QUEUE_ALREADY_OPEN' });

  await rm(join(queueRoot, '.owner.lock'));
  const recovered = await new DurableLocalJobQueue({
    root: queueRoot,
    allowedJobTypes: ['pdf_review'],
  }).initialize();
  await recovered.close();
});
