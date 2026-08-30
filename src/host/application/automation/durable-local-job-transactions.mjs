import {
  canonicalQueueJson, frozenQueueCopy, isQueueTransaction, queueFail,
} from './durable-local-job-record.mjs';
import { writeQueueState } from './durable-local-job-journal.mjs';

export async function transactionReferences(runtime) {
  await runtime.mutation;
  if (!runtime.state || !runtime.ownership || runtime.closing || runtime.closed) {
    queueFail('QUEUE_NOT_INITIALIZED', 'Initialize the queue before use.', 500);
  }
  const committed = new Map();
  const discard = new Map();
  for (const job of runtime.state.jobs) {
    for (const transaction of [job.transaction.source, job.transaction.output]) {
      if (!transaction) continue;
      const target = transaction.kind === 'source' || job.status === 'completed' ? committed : discard;
      const key = `${transaction.kind}:${transaction.id}`;
      if (target.has(key) || (target === committed ? discard : committed).has(key)) {
        queueFail('QUEUE_TRANSACTION_CONFLICT', 'Queue journal contains crossed transaction references.', 500);
      }
      target.set(key, frozenQueueCopy(transaction));
    }
  }
  return Object.freeze({
    committed: Object.freeze([...committed.values()]),
    discard: Object.freeze([...discard.values()]),
  });
}

export function acknowledgeDiscardedTransactions(runtime, references = []) {
  const run = runtime.mutation.then(async () => {
    if (!runtime.state || !runtime.ownership || runtime.closing || runtime.closed) queueFail('QUEUE_NOT_INITIALIZED', 'Initialize the queue before use.', 500);
    const snapshot = JSON.parse(canonicalQueueJson(runtime.state));
    try { for (const reference of references) {
      if (!isQueueTransaction(reference) || reference === null || reference.kind !== 'output') queueFail('QUEUE_TRANSACTION_CONFLICT', 'Discard acknowledgement is not an exact output reference.', 409);
      let matches = 0;
      for (const job of runtime.state.jobs) if (job.transaction.output && canonicalQueueJson(job.transaction.output) === canonicalQueueJson(reference)) { matches += 1; job.transaction = { ...job.transaction, output: null }; }
      if (matches !== 1) queueFail('QUEUE_TRANSACTION_CONFLICT', 'Discard acknowledgement does not match exactly one queue output.', 409);
    }
    await writeQueueState(runtime); } catch (error) { runtime.state = snapshot; throw error; }
  });
  runtime.mutation = run.catch(() => {});
  return run;
}
