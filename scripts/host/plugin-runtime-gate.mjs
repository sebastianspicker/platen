import {
  inspectPluginExecutionGate,
  PLUGIN_EXECUTION_REQUIREMENTS,
} from '../../src/core/plugin-host.js';
import { PluginNativeRuntime } from './plugin-native-runtime.mjs';

function readinessSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return null;
  const names = Object.getOwnPropertyNames(value).sort();
  const expected = [...PLUGIN_EXECUTION_REQUIREMENTS].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return null;
  const snapshot = {};
  for (const name of PLUGIN_EXECUTION_REQUIREMENTS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value !== true) return null;
    snapshot[name] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

/**
 * Internal, default-off composition boundary for the production native runtime.
 * This intentionally has no route or UI caller: only a complete, host-derived
 * readiness record may construct a runtime, and construction itself issues no
 * plugin authority.
 */
export function createPluginRuntimeGate({
  readiness = null,
  packages,
  grants,
  handles,
  supervisor,
  activations,
  audit,
  createRuntime = (options) => new PluginNativeRuntime(options),
} = {}) {
  const evidence = readinessSnapshot(readiness);
  if (!evidence || !inspectPluginExecutionGate(evidence).ready) return null;
  if (typeof createRuntime !== 'function') throw new TypeError('createRuntime must be callable.');
  return createRuntime({ packages, grants, handles, supervisor, activations, audit });
}

export { PLUGIN_EXECUTION_REQUIREMENTS as PLUGIN_RUNTIME_READINESS_FIELDS };
