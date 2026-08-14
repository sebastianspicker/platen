import { HostError } from '../host-error.mjs';

const RETRYABLE_ENGINE_CODES = new Set(['ENGINE_BUSY', 'ENGINE_QUEUE_FULL']);
const MAX_LEASE_MS = 10 * 60 * 1000;

function workerError(code, message, status = 409) {
  return new HostError(code, message, status);
}

export class AutomationWorker {
  #queue; #registry; #sources; #store; #service; #outputIntentService; #workerId;
  #leaseMs; #heartbeatMs; #retryDelayMs;
  #active = null; #running = null; #closing = false; #closed = false;

  constructor({
    queue, registry, sources, store, service, outputIntentService = null,
    workerId = 'automation_worker', leaseMs = 60_000,
    heartbeatMs = Math.max(1_000, Math.floor(leaseMs / 3)), retryDelayMs = 1_000,
  } = {}) {
    if (!queue || typeof queue.claim !== 'function' || typeof queue.renew !== 'function'
      || !registry || !sources || !store || !service
      || !/^[A-Za-z0-9_-]{1,128}$/u.test(workerId)
      || !Number.isSafeInteger(leaseMs) || leaseMs < 2 || leaseMs > MAX_LEASE_MS
      || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= leaseMs
      || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1
      || retryDelayMs > 24 * 60 * 60 * 1000) {
      throw new TypeError('AutomationWorker configuration is invalid.');
    }
    this.#queue = queue;
    this.#registry = registry;
    this.#sources = sources;
    this.#store = store;
    this.#service = service;
    this.#outputIntentService = outputIntentService;
    this.#workerId = workerId;
    this.#leaseMs = leaseMs;
    this.#heartbeatMs = heartbeatMs;
    this.#retryDelayMs = retryDelayMs;
  }

  runOnce({ signal } = {}) {
    if (this.#closed || this.#closing) {
      return Promise.reject(workerError('AUTOMATION_WORKER_CLOSED', 'Automation worker is closed.'));
    }
    if (this.#running) {
      return Promise.reject(workerError('AUTOMATION_WORKER_BUSY', 'Automation worker is already running.'));
    }
    const operation = this.#executeOnce(signal);
    let tracked;
    tracked = operation.finally(() => {
      if (this.#running === tracked) this.#running = null;
    });
    this.#running = tracked;
    return tracked;
  }

  async #executeOnce(signal) {
    const claim = await this.#queue.claim({
      workerId: this.#workerId,
      leaseMs: this.#leaseMs,
    });
    if (!claim) return Object.freeze({ ran: false });
    const controller = new AbortController();
    const active = this.#activeClaim(claim, controller);
    this.#active = active;
    const abort = () => { void active.cancel(signal?.reason).catch(() => {}); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let pendingOutput = null;
    let outputCommitted = false;
    let queueCompleted = false;
    try {
      const execution = await this.#registry.execute(claim.type, claim.payload, {
        sources: this.#sources,
        store: this.#store,
        service: this.#service,
        outputIntentService: this.#outputIntentService,
        signal: controller.signal,
      });
      const result = execution?.pendingOutput ? execution.receipt : execution;
      pendingOutput = execution?.pendingOutput ?? null;
      await active.stopRenewal();
      if (active.cancelRequested) return this.#cancelledResult(claim.id, active);
      if (active.renewalError) throw active.renewalError;
      if (pendingOutput) {
        await this.#queue.recordTransaction(claim.id, claim.lease.token, {
          kind: 'output', id: pendingOutput.id, sha256: pendingOutput.sha256,
          size: pendingOutput.size, sourceId: pendingOutput.sourceId,
          sourceSha256: pendingOutput.sourceSha256,
        });
      }
      const job = await this.#queue.complete(claim.id, claim.lease.token, result);
      queueCompleted = true;
      if (pendingOutput) {
        await this.#sources.commitOutput(pendingOutput);
        outputCommitted = true;
      }
      return Object.freeze({ ran: true, job, receipt: job.receipt });
    } catch (error) {
      await active.stopRenewal();
      if (pendingOutput) {
        const current = await this.#queue.get(claim.id).catch(() => null);
        if (current?.status === 'completed' && current.transaction?.output
          && current.transaction.output.id === pendingOutput.id
          && current.transaction.output.sha256 === pendingOutput.sha256) {
          outputCommitted = true;
        }
      }
      if (active.cancelRequested) return this.#cancelledResult(claim.id, active);
      const classification = RETRYABLE_ENGINE_CODES.has(error?.code)
        ? 'transient' : 'permanent';
      const message = error instanceof HostError
        ? error.message : 'Automation operation failed.';
      try {
        await this.#queue.fail(claim.id, claim.lease.token, {
          classification,
          message,
          ...(classification === 'transient' ? { retryDelayMs: this.#retryDelayMs } : {}),
        });
      } catch (failure) {
        if (failure?.code !== 'QUEUE_LEASE_CONFLICT') throw failure;
      }
      return this.#currentResult(claim.id);
    } finally {
      if (pendingOutput && !outputCommitted && !queueCompleted) {
        await this.#sources.discardCreatedOutput(pendingOutput);
      }
      signal?.removeEventListener('abort', abort);
      if (this.#active === active) this.#active = null;
    }
  }

  #activeClaim(claim, controller) {
    let stopped = false;
    let renewal = Promise.resolve();
    const active = {
      id: claim.id,
      controller,
      cancelRequested: false,
      cancellation: null,
      renewalError: null,
      cancel: (reason) => {
        if (!active.cancellation) {
          active.cancelRequested = true;
          stopped = true;
          clearInterval(timer);
          active.cancellation = this.#queue.cancel(claim.id);
          controller.abort(reason ?? new Error('Automation job cancelled.'));
        }
        return active.cancellation;
      },
      stopRenewal: async () => {
        stopped = true;
        clearInterval(timer);
        await renewal;
      },
    };
    const renew = () => {
      renewal = renewal.then(async () => {
        if (!stopped) await this.#queue.renew(
          claim.id, claim.lease.token, { leaseMs: this.#leaseMs },
        );
      }).catch((error) => {
        active.renewalError ??= error;
        stopped = true;
        clearInterval(timer);
        controller.abort(error);
      });
    };
    const timer = setInterval(renew, this.#heartbeatMs);
    timer.unref?.();
    return active;
  }

  async #currentResult(id) {
    const job = await this.#queue.get(id);
    return Object.freeze({ ran: true, job, receipt: await this.#queue.receipt(id) });
  }

  async #cancelledResult(id, active) {
    await active.cancellation;
    return this.#currentResult(id);
  }

  cancel(id) {
    if (this.#active?.id === id) return this.#active.cancel();
    return this.#queue.cancel(id);
  }

  async close() {
    if (this.#closed) return;
    this.#closing = true;
    const failures = [];
    try {
      try { if (this.#active) await this.#active.cancel(); } catch (error) { failures.push(error); }
      try { await this.#running; } catch (error) { failures.push(error); }
    } finally {
      this.#closed = true;
      this.#closing = false;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Automation worker could not close cleanly.');
  }
}
