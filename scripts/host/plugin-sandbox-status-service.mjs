import { createBlockedPluginSandboxStatus } from '../../src/core/plugin-sandbox-status-contract.js';
import { inspectDarwinPluginSandbox } from './plugin-sandbox-darwin.mjs';
import { HostError } from './host-error.mjs';

function exactObject(value, keys) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function cancelledError() {
  return new HostError('JOB_CANCELLED', 'The plugin sandbox status inspection was cancelled.', 499);
}

export class PluginSandboxStatusService {
  #inspect;
  #runner;
  #statusPromise = null;

  constructor({ inspect = inspectDarwinPluginSandbox, runner } = {}) {
    if (typeof inspect !== 'function') throw new TypeError('inspect must be a function.');
    if (typeof runner !== 'function') throw new TypeError('runner must be a function.');
    this.#inspect = inspect;
    this.#runner = runner;
  }

  getStatus(options = {}) {
    const keys = options?.signal === undefined ? [] : ['signal'];
    if (!exactObject(options, keys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
      throw new TypeError('plugin sandbox status options are invalid.');
    }
    if (options.signal?.aborted) {
      return Promise.reject(cancelledError());
    }
    if (!this.#statusPromise) {
      this.#statusPromise = Promise.resolve()
        .then(() => this.#inspect({ runner: this.#runner }))
        .then((observation) => createBlockedPluginSandboxStatus(observation))
        .catch(() => createBlockedPluginSandboxStatus(null));
    }
    if (options.signal === undefined) return this.#statusPromise;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => options.signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cancelledError());
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      this.#statusPromise.then(
        (status) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(status);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  }
}
