import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableLocalJobQueue } from '../scripts/host/automation/durable-local-job-queue.mjs';
import {
  LEGACY_AUTOMATION_TYPES,
  SEQUENCE_AUTOMATION_TYPES,
} from '../scripts/host/automation/durable-local-job-policy-migration.mjs';

async function legacyQueue(t, suffix, options = {}) {
  const root = await mkdtemp(join(tmpdir(), `pdf-sequence-policy-${suffix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = await new DurableLocalJobQueue({
    root,
    allowedJobTypes: LEGACY_AUTOMATION_TYPES,
    ...options,
  }).initialize();
  return { root, queue };
}

test('queue migrates only the exact legacy four-type automation policy to five types', async (t) => {
  const { root, queue } = await legacyQueue(t, 'exact');
  const queued = await queue.enqueue({
    type: 'automation_inspect_v1',
    payload: { sourceId: 'source_1', sha256: 'a'.repeat(64) },
    idempotencyKey: 'legacy-inspect',
  });
  await queue.close();
  const reopened = await new DurableLocalJobQueue({
    root, allowedJobTypes: SEQUENCE_AUTOMATION_TYPES,
  }).initialize();
  t.after(() => reopened.close().catch(() => {}));
  assert.equal((await reopened.get(queued.job.id)).type, 'automation_inspect_v1');
  const journal = JSON.parse(await readFile(join(root, 'journal.json'), 'utf8'));
  assert.deepEqual(journal.policy.allowedJobTypes, SEQUENCE_AUTOMATION_TYPES);
});

test('queue rejects sequence policy migration when limits differ', async (t) => {
  const { root, queue } = await legacyQueue(t, 'limits');
  await queue.close();
  await assert.rejects(new DurableLocalJobQueue({
    root,
    allowedJobTypes: SEQUENCE_AUTOMATION_TYPES,
    limits: { maxJobs: 255 },
  }).initialize(), { code: 'QUEUE_POLICY_MISMATCH' });
});

test('queue rejects migration from altered legacy or target type sets', async (t) => {
  const altered = [...LEGACY_AUTOMATION_TYPES, 'automation_unapproved_v1'];
  const first = await legacyQueue(t, 'altered-source', { allowedJobTypes: altered });
  await first.queue.close();
  await assert.rejects(new DurableLocalJobQueue({
    root: first.root, allowedJobTypes: SEQUENCE_AUTOMATION_TYPES,
  }).initialize(), { code: 'QUEUE_POLICY_MISMATCH' });

  const second = await legacyQueue(t, 'altered-target');
  await second.queue.close();
  await assert.rejects(new DurableLocalJobQueue({
    root: second.root,
    allowedJobTypes: [...SEQUENCE_AUTOMATION_TYPES, 'automation_unapproved_v1'],
  }).initialize(), { code: 'QUEUE_POLICY_MISMATCH' });
});
