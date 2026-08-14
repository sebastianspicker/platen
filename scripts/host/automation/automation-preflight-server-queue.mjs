import { HostError } from '../host-error.mjs';

export const AUTOMATION_PREFLIGHT_SERVER_MAX_CONCURRENCY = 2;
export const AUTOMATION_PREFLIGHT_SERVER_MAX_QUEUED = 16;

export class AutomationPreflightServerQueue {
  #concurrency; #maximumQueued; #active = 0; #pending = []; #entries = new Map(); #closed = false;

  constructor({ concurrency = AUTOMATION_PREFLIGHT_SERVER_MAX_CONCURRENCY,
    maximumQueued = AUTOMATION_PREFLIGHT_SERVER_MAX_QUEUED } = {}) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > AUTOMATION_PREFLIGHT_SERVER_MAX_CONCURRENCY
      || !Number.isSafeInteger(maximumQueued) || maximumQueued < 1 || maximumQueued > AUTOMATION_PREFLIGHT_SERVER_MAX_QUEUED) throw new TypeError('Preflight server queue limits are invalid.');
    this.#concurrency = concurrency; this.#maximumQueued = maximumQueued;
  }

  enqueue(id, controller, task) {
    if (this.#closed) throw new HostError('AUTOMATION_PREFLIGHT_SERVER_CLOSED', 'Preflight server queue is closed.', 409);
    if (this.#entries.has(id)) return this.#entries.get(id).promise;
    if (this.#pending.length >= this.#maximumQueued) throw new HostError('AUTOMATION_PREFLIGHT_SERVER_QUEUE_FULL', 'Preflight server queue is full.', 429);
    let resolve; let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    const entry = { id, controller, task, promise, resolve, reject, state: 'queued' };
    this.#entries.set(id, entry); this.#pending.push(entry); this.#pump();
    return promise;
  }

  cancel(id) {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    entry.controller.abort();
    if (entry.state === 'queued') {
      this.#pending = this.#pending.filter((item) => item !== entry);
      entry.state = 'cancelled';
      entry.reject(new HostError('AUTOMATION_PREFLIGHT_SERVER_CANCELLED', 'Preflight server job was cancelled.', 499));
      this.#entries.delete(id);
    }
    return true;
  }

  #pump() {
    while (!this.#closed && this.#active < this.#concurrency && this.#pending.length) {
      const entry = this.#pending.shift();
      if (entry.controller.signal.aborted) { this.cancel(entry.id); continue; }
      entry.state = 'running'; this.#active += 1;
      Promise.resolve().then(() => entry.task(entry.controller.signal)).then(entry.resolve, entry.reject).finally(() => {
        entry.state = 'settled'; this.#entries.delete(entry.id); this.#active -= 1; this.#pump();
      });
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#entries.values()];
    for (const entry of entries) {
      entry.controller.abort();
      if (entry.state === 'queued') {
        entry.state = 'cancelled';
        entry.reject(new HostError('AUTOMATION_PREFLIGHT_SERVER_CANCELLED', 'Preflight server job was cancelled.', 499));
        this.#entries.delete(entry.id);
      }
    }
    await Promise.allSettled(entries.map((entry) => entry.promise));
  }
}
