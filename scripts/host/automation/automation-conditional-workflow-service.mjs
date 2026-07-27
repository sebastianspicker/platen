import { types as nodeTypes } from 'node:util';
import { HostError } from '../host-error.mjs';
import {
  AUTOMATION_CONDITIONAL_MAX_EXECUTIONS,
  conditionalExecutionId,
  conditionalFail,
  conditionalWorkflowFingerprint,
  normalizeAutomationConditionalCancelRequest,
  normalizeAutomationConditionalExecuteRequest,
} from './automation-conditional-workflow-contract.mjs';
import { executeAutomationConditionalWorkflow } from './automation-conditional-workflow-runtime.mjs';
import {
  AUTOMATION_INSPECT_PRESET, AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_PRESET,
  AUTOMATION_OCR_TYPE, AUTOMATION_OUTPUT_INTENT_PRESET, AUTOMATION_OUTPUT_INTENT_TYPE,
} from './automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_TYPE } from './automation-sequence-contract.mjs';

function expectedType(operation) {
  if (operation.kind === 'sequence') return AUTOMATION_SEQUENCE_TYPE;
  if (operation.kind === 'preset') {
    if (operation.id === AUTOMATION_INSPECT_PRESET) return AUTOMATION_INSPECT_TYPE;
    if (operation.id === AUTOMATION_OCR_PRESET) return AUTOMATION_OCR_TYPE;
    if (operation.id === AUTOMATION_OUTPUT_INTENT_PRESET) return AUTOMATION_OUTPUT_INTENT_TYPE;
  }
  return operation.id;
}

function checkedQueued(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) conditionalFail('AUTOMATION_CONDITIONAL_QUEUE_RESULT_INVALID', 'Conditional queue response is invalid.', 502);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 3 || !Object.hasOwn(descriptors, 'schemaVersion') || !Object.hasOwn(descriptors, 'idempotent') || !Object.hasOwn(descriptors, 'job')
    || Reflect.ownKeys(value).some((key) => !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)
    || descriptors.schemaVersion.value !== 1 || typeof descriptors.idempotent.value !== 'boolean') conditionalFail('AUTOMATION_CONDITIONAL_QUEUE_RESULT_INVALID', 'Conditional queue response is invalid.', 502);
  const job = descriptors.job.value;
  if (!job || typeof job !== 'object' || Array.isArray(job) || nodeTypes.isProxy(job) || Object.getPrototypeOf(job) !== Object.prototype) conditionalFail('AUTOMATION_CONDITIONAL_QUEUE_RESULT_INVALID', 'Conditional queue job is invalid.', 502);
  const jobDescriptors = Object.getOwnPropertyDescriptors(job);
  if (!Object.hasOwn(jobDescriptors, 'id') || !Object.hasOwn(jobDescriptors, 'type') || !Object.hasOwn(jobDescriptors, 'status')
    || Reflect.ownKeys(job).some((key) => !Object.hasOwn(jobDescriptors[key], 'value') || jobDescriptors[key].enumerable !== true)
    || typeof jobDescriptors.id.value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(jobDescriptors.id.value)
    || jobDescriptors.type.value !== expectedType(operation)
    || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(jobDescriptors.status.value)) conditionalFail('AUTOMATION_CONDITIONAL_QUEUE_RESULT_INVALID', 'Conditional queue job identity is invalid.', 502);
  return Object.freeze({ id: jobDescriptors.id.value, status: jobDescriptors.status.value, idempotent: descriptors.idempotent.value });
}

function denied(error) {
  if (error instanceof HostError && error.code === 'AUTOMATION_CONDITIONAL_CAPABILITY_DENIED') throw error;
  throw new HostError('AUTOMATION_CONDITIONAL_CAPABILITY_DENIED', 'Conditional workflow capability was denied.', 403, { cause: error });
}

export class AutomationConditionalWorkflowService {
  #api; #authority; #facts; #executions = new Map(); #closed = false;

  constructor({ api, authority, factsProvider } = {}) {
    if (typeof api?.submit !== 'function' || typeof api?.cancel !== 'function' || typeof authority?.authorize !== 'function'
      || typeof factsProvider?.inspectVerified !== 'function') throw new TypeError('Conditional workflows require Automation API, capability authority, and verified facts provider.');
    this.#api = api; this.#authority = authority; this.#facts = factsProvider;
  }

  async #authorize(request, action, operation = null) {
    try {
      const result = await this.#authority.authorize(request.grant, Object.freeze({
        principal: request.principal, capability: 'automation.conditional', action: `conditional.${action}`,
        executionId: request.executionId ?? null, source: request.source ? Object.freeze({ ...request.source }) : null,
        workflowId: request.workflow?.workflowId ?? null,
        operation: operation ? Object.freeze({ ...operation, pages: operation.pages === null ? null : Object.freeze([...operation.pages]) }) : null,
      }));
      if (result === false) throw new HostError('AUTOMATION_CONDITIONAL_CAPABILITY_DENIED', 'denied', 403);
    } catch (error) { denied(error); }
  }

  execute(value, { signal = null } = {}) {
    if (this.#closed) conditionalFail('AUTOMATION_CONDITIONAL_CLOSED', 'Conditional workflow service is closed.', 409);
    const request = normalizeAutomationConditionalExecuteRequest(value);
    const executionId = conditionalExecutionId(request);
    const fingerprint = conditionalWorkflowFingerprint(request);
    const key = `${request.principal}\u0000${request.idempotencyKey}`;
    const prior = this.#executions.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) conditionalFail('AUTOMATION_CONDITIONAL_REPLAY_CONFLICT', 'Conditional idempotency key belongs to another workflow.', 409);
      return prior.promise;
    }
    if (this.#executions.size >= AUTOMATION_CONDITIONAL_MAX_EXECUTIONS) conditionalFail('AUTOMATION_CONDITIONAL_EXECUTION_LIMIT', 'Conditional execution limit has been reached.', 429);
    const controller = new AbortController();
    const bound = Object.freeze({ ...request, executionId });
    const record = { principal: request.principal, grant: request.grant, source: request.source, workflow: request.workflow,
      fingerprint, executionId, controller, jobs: [], cancellationAttempts: new Set(), cleanupFailures: [], cleanup: Promise.resolve(), promise: null };
    const onAbort = () => { controller.abort(); void this.#cleanupRecord(record).catch(() => {}); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    record.promise = this.#run(bound, controller.signal, record).finally(() => signal?.removeEventListener?.('abort', onAbort));
    this.#executions.set(key, record);
    return record.promise;
  }

  async #run(request, signal, record) {
    try {
      await this.#authorize(request, 'execute');
      if (signal.aborted) throw new HostError('AUTOMATION_CONDITIONAL_CANCELLED', 'Conditional workflow was cancelled.', 499);
      const facts = await this.#facts.inspectVerified(request.source, { signal });
      if (signal.aborted) throw new HostError('AUTOMATION_CONDITIONAL_CANCELLED', 'Conditional workflow was cancelled.', 499);
      return await executeAutomationConditionalWorkflow({ request, facts, signal, submit: async (operation, idempotencyKey) => {
        await this.#authorize(request, 'submit', operation);
        if (signal.aborted) throw new HostError('AUTOMATION_CONDITIONAL_CANCELLED', 'Conditional workflow was cancelled.', 499);
        const queued = checkedQueued(await this.#api.submit({ principal: request.principal, grant: request.grant, source: request.source, operation, idempotencyKey }), operation);
        record.jobs.push(queued.id);
        if (signal.aborted) throw new HostError('AUTOMATION_CONDITIONAL_CANCELLED', 'Conditional workflow was cancelled.', 499);
        return queued;
      } });
    } catch (error) {
      try { await this.#cleanupRecord(record); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Conditional workflow and queued-job cleanup failed.');
      }
      throw error;
    }
  }

  #cleanupRecord(record) {
    const run = record.cleanup.catch(() => {}).then(async () => {
      const pending = record.jobs.filter((jobId) => !record.cancellationAttempts.has(jobId));
      const failures = [];
      for (const jobId of pending) {
        record.cancellationAttempts.add(jobId);
        try { await this.#api.cancel({ principal: record.principal, grant: record.grant, jobId }); }
        catch (error) { failures.push(error); }
      }
      if (failures.length > 0) {
        const failure = failures.length === 1 ? failures[0] : new AggregateError(failures, 'Conditional queued-job cleanup failed.');
        record.cleanupFailures.push(failure);
        throw failure;
      }
    });
    record.cleanup = run;
    return run;
  }

  async cancel(value) {
    const request = normalizeAutomationConditionalCancelRequest(value);
    await this.#authorize(request, 'cancel');
    const record = [...this.#executions.values()].find((item) => item.executionId === request.executionId
      && item.principal === request.principal && item.grant.grantId === request.grant.grantId);
    if (!record) conditionalFail('AUTOMATION_CONDITIONAL_NOT_FOUND', 'Conditional execution was not found.', 404);
    await this.#authorize({ ...request, source: record.source, workflow: record.workflow }, 'cancel');
    record.controller.abort();
    await this.#cleanupRecord(record);
    return Object.freeze({ schemaVersion: 1, executionId: request.executionId, cancelled: true });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const records = [...this.#executions.values()];
    for (const record of records) record.controller.abort();
    await Promise.allSettled(records.map((record) => this.#cleanupRecord(record)));
    await Promise.allSettled(records.map((record) => record.promise));
    await Promise.allSettled(records.map((record) => this.#cleanupRecord(record)));
    const failures = [...new Set(records.flatMap((record) => record.cleanupFailures))];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Conditional workflow close failed.');
  }
}
