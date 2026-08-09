import { HostError } from '../host-error.mjs';
import {
  AUTOMATION_JS_MAX_EXECUTIONS,
  automationJsExecutionId,
  automationJsFail,
  automationJsFingerprint,
  normalizeAutomationJsCancelRequest,
  normalizeAutomationJsExecuteRequest,
  normalizeAutomationJsReleaseRequest,
} from './automation-js-contract.mjs';
import { AutomationJsRecipeRegistry } from './automation-js-registry.mjs';
import { executeAutomationJsRecipe } from './automation-js-runtime.mjs';

function denied(error) {
  if (error instanceof HostError && error.code === 'AUTOMATION_JS_CAPABILITY_DENIED') throw error;
  throw new HostError('AUTOMATION_JS_CAPABILITY_DENIED',
    'Declarative automation recipe capability was denied.', 403, { cause: error });
}

export class AutomationJsService {
  #api; #authority; #registry; #executions = new Map(); #closed = false; #closeOperation = null;

  constructor({ api, authority, registry = new AutomationJsRecipeRegistry() } = {}) {
    if (typeof api?.submit !== 'function' || typeof api?.cancel !== 'function'
      || typeof authority?.authorize !== 'function' || typeof registry?.descriptor !== 'function') {
      throw new TypeError('AutomationJsService requires Automation API, capability authority, and recipe registry.');
    }
    this.#api = api;
    this.#authority = authority;
    this.#registry = registry;
  }

  async #authorize(request, action, operation = null) {
    try {
      const result = await this.#authority.authorize(request.grant, Object.freeze({
        principal: request.principal,
        capability: 'automation.javascript',
        action: `automation-js.${action}`,
        executionId: request.executionId ?? null,
        source: request.source ? Object.freeze({ id: request.source.id,
          sha256: request.source.sha256 }) : null,
        recipe: request.recipe ? Object.freeze({ ...request.recipe }) : null,
        operation,
      }));
      if (result === false) {
        throw new HostError('AUTOMATION_JS_CAPABILITY_DENIED', 'denied', 403);
      }
    } catch (error) { denied(error); }
  }

  execute(value, { signal = null } = {}) {
    if (this.#closed) automationJsFail('AUTOMATION_JS_CLOSED',
      'Declarative automation recipe service is closed.', 409);
    if (signal !== null && !(signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal');
    }
    const request = normalizeAutomationJsExecuteRequest(value);
    const descriptor = this.#registry.descriptor(request.recipe.id, request.recipe.version);
    const executionId = automationJsExecutionId(request);
    const fingerprint = automationJsFingerprint(request);
    const key = `${request.principal}\u0000${request.idempotencyKey}`;
    const prior = this.#executions.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        automationJsFail('AUTOMATION_JS_REPLAY_CONFLICT',
          'Declarative recipe idempotency key belongs to another request.', 409);
      }
      return prior.promise;
    }
    if (this.#executions.size >= AUTOMATION_JS_MAX_EXECUTIONS) {
      automationJsFail('AUTOMATION_JS_EXECUTION_LIMIT',
        'Declarative recipe execution limit has been reached.', 429);
    }
    const controller = new AbortController();
    const bound = Object.freeze({ ...request, executionId });
    const record = {
      principal: request.principal,
      grant: request.grant,
      source: request.source,
      recipe: request.recipe,
      executionId,
      fingerprint,
      controller,
      jobs: new Map(),
      cleanup: Promise.resolve(),
      promise: null,
    };
    const onAbort = () => {
      controller.abort();
      void this.#cleanupRecord(record).catch(() => {});
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    record.promise = this.#run(bound, descriptor, controller.signal, record)
      .finally(() => signal?.removeEventListener('abort', onAbort));
    this.#executions.set(key, record);
    return record.promise;
  }

  async #run(request, descriptor, signal, record) {
    try {
      await this.#authorize(request, 'execute');
      if (signal.aborted) {
        throw new HostError('AUTOMATION_JS_CANCELLED',
          'Declarative recipe execution was cancelled.', 499);
      }
      return await executeAutomationJsRecipe({
        request,
        descriptor,
        signal,
        onAdmitted: (jobId, idempotencyKey) => {
          const existing = record.jobs.get(jobId);
          if (existing && existing.idempotencyKey !== idempotencyKey) {
            throw new HostError('AUTOMATION_JS_QUEUE_RESULT_INVALID',
              'Declarative recipe queue job identity was reused by another request.', 502);
          }
          if (!existing) record.jobs.set(jobId, {
            id: jobId, idempotencyKey, state: 'idle', inFlight: null, error: null,
          });
        },
        submit: async (operation, idempotencyKey) => {
          await this.#authorize(request, 'submit', operation);
          if (signal.aborted) {
            throw new HostError('AUTOMATION_JS_CANCELLED',
              'Declarative recipe execution was cancelled.', 499);
          }
          return this.#api.submit({
            principal: request.principal,
            grant: request.grant,
            source: request.source,
            operation,
            idempotencyKey,
          });
        },
      });
    } catch (error) {
      try { await this.#cleanupRecord(record); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError],
          'Declarative recipe execution and queued-job cleanup failed.');
      }
      throw error;
    }
  }

  #cancelJob(record, job) {
    if (job.state === 'succeeded') return Promise.resolve();
    if (job.state === 'in-flight') return job.inFlight;
    job.state = 'in-flight';
    job.error = null;
    const attempt = Promise.resolve().then(() => this.#api.cancel({
      principal: record.principal,
      grant: record.grant,
      jobId: job.id,
    })).then(() => {
      job.state = 'succeeded';
      job.inFlight = null;
    }, (error) => {
      job.state = 'idle';
      job.inFlight = null;
      job.error = error;
      throw error;
    });
    job.inFlight = attempt;
    return attempt;
  }

  #cleanupRecord(record) {
    const run = record.cleanup.catch(() => {}).then(async () => {
      const failures = [];
      for (const job of record.jobs.values()) {
        try { await this.#cancelJob(record, job); }
        catch (error) { failures.push(error); }
      }
      if (failures.length > 0) {
        throw failures.length === 1 ? failures[0]
          : new AggregateError(failures, 'Declarative recipe queued-job cleanup failed.');
      }
    });
    record.cleanup = run;
    return run;
  }

  async cancel(value) {
    const request = normalizeAutomationJsCancelRequest(value);
    const record = [...this.#executions.values()].find((item) => (
      item.executionId === request.executionId && item.principal === request.principal
      && item.grant.grantId === request.grant.grantId
    ));
    if (!record) automationJsFail('AUTOMATION_JS_NOT_FOUND',
      'Declarative recipe execution was not found.', 404);
    await this.#authorize({ ...request, source: record.source, recipe: record.recipe }, 'cancel');
    record.controller.abort();
    await this.#cleanupRecord(record);
    return Object.freeze({ schemaVersion: 1, executionId: request.executionId,
      cancelled: true, javascriptExecuted: false });
  }

  async release(value) {
    if (this.#closed) automationJsFail('AUTOMATION_JS_CLOSED',
      'Declarative automation recipe service is closed.', 409);
    const request = normalizeAutomationJsReleaseRequest(value);
    const match = [...this.#executions.entries()].find(([, item]) => (
      item.executionId === request.executionId && item.principal === request.principal
      && item.grant.grantId === request.grant.grantId
    ));
    if (!match) automationJsFail('AUTOMATION_JS_NOT_FOUND',
      'Declarative recipe execution was not found.', 404);
    const [key, record] = match;
    await this.#authorize({ ...request, source: record.source, recipe: record.recipe }, 'release');
    await record.promise;
    if (this.#executions.get(key) !== record) automationJsFail('AUTOMATION_JS_NOT_FOUND',
      'Declarative recipe execution was not found.', 404);
    this.#executions.delete(key);
    return Object.freeze({ schemaVersion: 1, executionId: request.executionId,
      released: true, javascriptExecuted: false, localOnly: true });
  }

  async close() {
    this.#closed = true;
    if (this.#closeOperation) return this.#closeOperation;
    const run = (async () => {
      const records = [...this.#executions.values()];
      for (const record of records) record.controller.abort();
      await Promise.allSettled(records.map((record) => this.#cleanupRecord(record)));
      await Promise.allSettled(records.map((record) => record.promise));
      await Promise.allSettled(records.map((record) => this.#cleanupRecord(record)));
      const failures = [...new Set(records.flatMap((record) => (
        [...record.jobs.values()].filter((job) => job.state !== 'succeeded' && job.error)
          .map((job) => job.error)
      )))];
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Declarative recipe close failed.');
      }
    })();
    this.#closeOperation = run;
    try { await run; }
    finally { if (this.#closeOperation === run) this.#closeOperation = null; }
  }
}
