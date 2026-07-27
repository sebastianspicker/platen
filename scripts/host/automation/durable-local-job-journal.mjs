import { HostError } from '../host-error.mjs';
import {
  DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
  canonicalQueueJson,
  normalizeQueueTransaction,
  queueFail,
  queuePolicySnapshot,
  validateQueueState,
} from './durable-local-job-record.mjs';
import {
  assertPrivateQueueOwnership,
  readPrivateQueueJournal,
  writePrivateQueueJournal,
} from './durable-local-job-storage.mjs';
import { migrateAutomationSequencePolicy } from './durable-local-job-policy-migration.mjs';

export function emptyQueueState(runtime) {
  return {
    schemaVersion: DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
    policy: queuePolicySnapshot(runtime.allowedJobTypes, runtime.limits),
    jobs: [],
  };
}

export async function readQueueState(runtime) {
  await assertPrivateQueueOwnership(runtime.ownership);
  const maximumBytes = runtime.limits.maxJobs * runtime.limits.maxRecordBytes;
  const bytes = await readPrivateQueueJournal(runtime.journalPath, maximumBytes);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const state = JSON.parse(text);
    if (canonicalQueueJson(state) !== text) {
      queueFail('QUEUE_JOURNAL_CORRUPT', 'Queue journal is not canonical.', 500);
    }
    let legacy = false;
    if (Array.isArray(state.jobs)) {
      for (const job of state.jobs) {
        if (!Object.hasOwn(job, 'transaction')) {
          job.transaction = null;
          legacy = true;
        } else if (job.transaction !== null && !(Object.hasOwn(job.transaction, 'source') && Object.hasOwn(job.transaction, 'output'))) {
          job.transaction = normalizeQueueTransaction(job.transaction);
          if (!job.transaction) queueFail('QUEUE_JOURNAL_CORRUPT', 'Queue journal transaction is invalid.', 500);
          legacy = true;
        }
      }
    }
    const policyMigrated = migrateAutomationSequencePolicy(state, runtime);
    validateQueueState(state, runtime.limits, runtime.allowedJobTypes);
    if (policyMigrated || legacy) await writeQueueState({ ...runtime, state });
    return state;
  } catch (error) {
    if (error instanceof HostError
      && ['QUEUE_JOURNAL_CORRUPT', 'QUEUE_POLICY_MISMATCH'].includes(error.code)) {
      throw error;
    }
    queueFail('QUEUE_JOURNAL_CORRUPT', 'Queue journal is corrupt.', 500);
  }
}

export async function writeQueueState(runtime) {
  await assertPrivateQueueOwnership(runtime.ownership);
  validateQueueState(runtime.state, runtime.limits, runtime.allowedJobTypes);
  const text = canonicalQueueJson(runtime.state);
  const maximumBytes = runtime.limits.maxJobs * runtime.limits.maxRecordBytes;
  await writePrivateQueueJournal(runtime.journalPath, text, maximumBytes);
}

export async function recoverQueueClaims(runtime, timestamp, interrupted = false) {
  let changed = false;
  for (const job of runtime.state.jobs) {
    const leaseExpired = job.status === 'running' && job.lease.expiresAt <= timestamp;
    if (job.status !== 'running' || (!interrupted && !leaseExpired)) continue;
    changed = true;
    job.lease = null;
    job.updatedAt = timestamp;
    if (job.attempts >= job.maxAttempts) {
      job.status = 'failed';
      job.retry = null;
      job.receipt = {
        schemaVersion: DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
        status: 'failed',
        finishedAt: timestamp,
        result: null,
        error: {
          classification: 'interrupted',
          message: 'Job lease expired before completion.',
        },
      };
    } else {
      job.status = 'pending';
      job.retry = {
        classification: 'interrupted',
        notBefore: timestamp,
        message: 'Job recovered after lease expiry.',
      };
    }
  }
  if (changed) await writeQueueState(runtime);
}
