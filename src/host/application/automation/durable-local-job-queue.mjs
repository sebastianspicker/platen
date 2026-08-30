import {
  DEFAULT_DURABLE_LOCAL_JOB_QUEUE_LIMITS,
  DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
} from './durable-local-job-record.mjs';
import {
  cancelQueueJob,
  claimQueueJob,
  closeQueueRuntime,
  completeQueueJob,
  createDurableQueueRuntime,
  enqueueQueueJob,
  failQueueJob,
  getQueueJob,
  initializeQueueRuntime,
  inspectQueueAdmission,
  readQueueJobReceipt,
  renewQueueJob,
  recordQueueTransaction,
} from './durable-local-job-runtime.mjs';
import { acknowledgeDiscardedTransactions, transactionReferences } from './durable-local-job-transactions.mjs';

export {
  DEFAULT_DURABLE_LOCAL_JOB_QUEUE_LIMITS,
  DURABLE_LOCAL_JOB_QUEUE_SCHEMA_VERSION,
};

export class DurableLocalJobQueue {
  #runtime;

  constructor(options = {}) {
    this.#runtime = createDurableQueueRuntime(options);
  }

  async initialize() {
    await initializeQueueRuntime(this.#runtime);
    return this;
  }

  enqueue(request = {}) {
    return enqueueQueueJob(this.#runtime, request);
  }

  claim(request = {}) {
    return claimQueueJob(this.#runtime, request);
  }

  renew(id, leaseToken, request = {}) {
    return renewQueueJob(this.#runtime, id, leaseToken, request);
  }

  recordTransaction(id, leaseToken, transaction) {
    return recordQueueTransaction(this.#runtime, id, leaseToken, transaction);
  }

  acknowledgeDiscarded(references) {
    return acknowledgeDiscardedTransactions(this.#runtime, references);
  }

  recoveryReferences() {
    return transactionReferences(this.#runtime);
  }

  complete(id, leaseToken, result = null) {
    return completeQueueJob(this.#runtime, id, leaseToken, result);
  }

  fail(id, leaseToken, failure = {}) {
    return failQueueJob(this.#runtime, id, leaseToken, failure);
  }

  cancel(id) {
    return cancelQueueJob(this.#runtime, id);
  }

  get(id) {
    return getQueueJob(this.#runtime, id);
  }

  receipt(id) {
    return readQueueJobReceipt(this.#runtime, id);
  }

  admission(idempotencyKey) {
    return inspectQueueAdmission(this.#runtime, idempotencyKey);
  }

  close() {
    return closeQueueRuntime(this.#runtime);
  }

  [Symbol.asyncDispose]() {
    return this.close();
  }
}
