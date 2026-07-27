import { PlatenError } from './errors.js';
import { validateRuntimeManifest } from './validate.js';

export const PLUGIN_EXECUTION_REQUIREMENTS = Object.freeze([
  'signedPackage', 'privateIpc', 'osSandbox', 'noNetwork',
  'cpuQuota', 'hardMemoryQuota', 'processQuota', 'outputQuota',
  'scopedHandles', 'permissionGrants', 'rollback',
]);
export const PLUGIN_EXECUTION_BEST_EFFORT_EVIDENCE = Object.freeze([
  'rssWatchdog', 'v8HeapLimit', 'sandboxBehaviorProbe',
]);
export const PLUGIN_STATES = Object.freeze([
  'unavailable', 'resolving', 'awaiting-permission', 'activating', 'ready',
  'blocked', 'failed', 'deactivating',
]);

export function inspectPluginExecutionGate(evidence = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new TypeError('Plugin execution evidence must be an object.');
  }
  const missing = PLUGIN_EXECUTION_REQUIREMENTS.filter((requirement) => evidence[requirement] !== true);
  const observedBestEffort = PLUGIN_EXECUTION_BEST_EFFORT_EVIDENCE
    .filter((control) => evidence[control] === true);
  return Object.freeze({
    ready: missing.length === 0,
    required: PLUGIN_EXECUTION_REQUIREMENTS,
    missing: Object.freeze(missing),
    observedBestEffort: Object.freeze(observedBestEffort),
  });
}

export class PluginHost {
  #records = new Map();

  register(rawManifest) {
    const manifest = validateRuntimeManifest(rawManifest);
    if (this.#records.has(manifest.id)) {
      throw new PlatenError('MANIFEST_INVALID', `Plugin ${manifest.id} is already registered.`);
    }
    this.#records.set(manifest.id, { manifest, state: 'unavailable', error: null });
    return this.status(manifest.id);
  }

  status(id) {
    const record = this.#records.get(id);
    if (!record) return Object.freeze({ id, state: 'unavailable', registered: false, error: null });
    return Object.freeze({ id, state: record.state, registered: true, error: record.error });
  }

  async activate(id) {
    const record = this.#records.get(id);
    if (!record) throw new PlatenError('DEPENDENCY_MISSING', `Plugin ${id} is not registered.`);
    record.state = 'blocked';
    record.error = 'Executable plugin runtime is intentionally unavailable.';
    throw new PlatenError(
      'PLUGIN_RUNTIME_UNAVAILABLE',
      'Executable plugins remain disabled until a signed native containment helper passes the complete execution gate.',
    );
  }

  async deactivate(id) {
    const record = this.#records.get(id);
    if (!record || record.state === 'unavailable') return this.status(id);
    record.state = 'deactivating';
    record.state = 'unavailable';
    record.error = null;
    return this.status(id);
  }
}
