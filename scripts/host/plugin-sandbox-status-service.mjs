import { createBlockedPluginSandboxStatus } from '../../src/core/plugin-sandbox-status-contract.js';
import { inspectDarwinPluginSandbox } from './plugin-sandbox-darwin.mjs';

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

  getStatus() {
    if (!this.#statusPromise) {
      this.#statusPromise = Promise.resolve()
        .then(() => this.#inspect({ runner: this.#runner }))
        .then((observation) => createBlockedPluginSandboxStatus(observation))
        .catch(() => createBlockedPluginSandboxStatus(null));
    }
    return this.#statusPromise;
  }
}
