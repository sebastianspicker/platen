import { HostError } from './host-error.mjs';
import { validatePluginRpcBinding } from './plugin-rpc-contract.mjs';

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(code, message, status = 500, cause) {
  throw new HostError(code, message, status, cause === undefined ? {} : { cause });
}

function packageIdentity(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !SEMVER.test(value.version ?? '')
    || !SHA256.test(value.digest ?? '')) {
    throw new TypeError('Plugin package transition identity is invalid.');
  }
  return Object.freeze({ version: value.version, digest: value.digest });
}

function samePackage(record, identity) {
  return identity && record.binding.version === identity.version
    && record.binding.packageHash === identity.digest;
}

/** Coordinates activation changes with every live native operation for one plugin. */
export class PluginRuntimeAuthorityRegistry {
  #resolveActivation;
  #audit;
  #records = new Map();
  #tails = new Map();
  #quarantined = new Set();

  constructor({ resolveActivation, audit = () => {} } = {}) {
    if (typeof resolveActivation !== 'function' || typeof audit !== 'function') {
      throw new TypeError('Plugin runtime authority registry requires activation and audit callbacks.');
    }
    this.#resolveActivation = resolveActivation;
    this.#audit = audit;
  }

  async register({ binding, terminate } = {}) {
    const checked = validatePluginRpcBinding(binding);
    if (typeof terminate !== 'function') throw new TypeError('Plugin runtime termination callback is required.');
    return this.#serialize(checked.pluginId, async () => {
      if (this.#quarantined.has(checked.pluginId)) {
        fail('PLUGIN_RUNTIME_QUARANTINED', 'The plugin runtime is quarantined after incomplete termination.', 503);
      }
      const active = await this.#resolveActivation(checked.pluginId);
      if (active?.id !== checked.pluginId || active?.version !== checked.version
        || (active?.digest ?? active?.packageHash) !== checked.packageHash) {
        fail('PLUGIN_ACTIVATION_CHANGED', 'The active plugin package changed before runtime registration.', 409);
      }
      if (this.#records.has(checked.activationId)) {
        fail('PLUGIN_ACTIVATION_DUPLICATE', 'The plugin activation is already registered.', 409);
      }
      const record = { binding: checked, terminate, state: 'active' };
      this.#records.set(checked.activationId, record);
      let released = false; const registry = this;
      return Object.freeze({
        async release() {
          if (released) return false;
          released = true;
          if (record.state === 'active') record.state = 'released';
          registry.#records.delete(checked.activationId);
          return true;
        },
      });
    });
  }

  async transition({ id, previous, next, reason, commit } = {}) {
    if (!PLUGIN_ID.test(id ?? '') || typeof reason !== 'string' || !reason
      || typeof commit !== 'function') throw new TypeError('Plugin activation transition is invalid.');
    const from = packageIdentity(previous, { nullable: true });
    const to = packageIdentity(next);
    return this.#serialize(id, async () => {
      const errors = [];
      for (const [activationId, record] of this.#records) {
        if (record.binding.pluginId !== id || !['active', 'failed'].includes(record.state)
          || !samePackage(record, from)) continue;
        record.state = 'terminating';
        try {
          await record.terminate(`package-${reason}`);
          record.state = 'terminated';
          this.#records.delete(activationId);
        } catch (error) {
          record.state = 'failed';
          errors.push(error);
        }
      }
      if (errors.length !== 0) {
        this.#quarantined.add(id);
        fail(
          'PLUGIN_RUNTIME_TRANSITION_FAILED',
          'Existing plugin authority could not be terminated before the package transition.',
          500,
          new AggregateError(errors, 'Plugin runtime termination failed.'),
        );
      }
      if ([...this.#records.values()].some((record) => record.binding.pluginId === id && record.state === 'failed')) {
        this.#quarantined.add(id);
        fail('PLUGIN_RUNTIME_QUARANTINED', 'The plugin runtime remains quarantined after incomplete termination.', 503);
      }
      this.#audit({
        type: 'plugin.package.transition', pluginId: id, reason,
        previousVersion: from?.version ?? null, previousDigest: from?.digest ?? null,
        version: to.version, packageHash: to.digest,
      });
      await commit();
      this.#quarantined.delete(id);
      return Object.freeze({ id, version: to.version, digest: to.digest });
    });
  }

  get activeCount() {
    return [...this.#records.values()].filter((record) => ['active', 'terminating', 'failed'].includes(record.state)).length;
  }

  async #serialize(pluginId, work) {
    const prior = this.#tails.get(pluginId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.#tails.set(pluginId, current);
    await prior;
    try { return await work(); } finally {
      release();
      if (this.#tails.get(pluginId) === current) this.#tails.delete(pluginId);
    }
  }
}
