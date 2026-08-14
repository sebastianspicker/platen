export const PLUGIN_SANDBOX_HARD_CONTROLS = Object.freeze([
  'osSandbox',
  'noNetwork',
  'processQuota',
  'cpuQuota',
  'hardMemoryQuota',
]);

export const PLUGIN_SANDBOX_BEST_EFFORT_EVIDENCE = Object.freeze([
  'sandboxBehaviorProbe',
  'filesystemWriteDenied',
  'sensitiveFilesystemReadDenied',
  'networkCanaryDenied',
  'processForkCanaryDenied',
  'nodePermissionProbe',
  'cpuLimitCanary',
  'jitless',
]);

const REASON_CODES = new Set([
  'BEST_EFFORT_CANARIES_PASSED',
  'BEST_EFFORT_CANARIES_INCOMPLETE',
  'PROBE_UNAVAILABLE',
]);

function exactObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function exactBooleanRecord(value, keys) {
  return exactObject(value, keys) && keys.every((key) => typeof value[key] === 'boolean');
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length > 100) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

export function createBlockedPluginSandboxStatus(observation, {
  observedAtLocal = new Date().toISOString(),
} = {}) {
  const observedBestEffort = observation?.bestEffort;
  const bestEffortEvidence = Object.fromEntries(
    PLUGIN_SANDBOX_BEST_EFFORT_EVIDENCE.map((key) => [key, observedBestEffort?.[key] === true]),
  );
  const probeAvailable = observation?.available === true;
  const canariesPassed = probeAvailable
    && PLUGIN_SANDBOX_BEST_EFFORT_EVIDENCE.every((key) => bestEffortEvidence[key]);
  return validatePluginSandboxStatus({
    schemaVersion: 1,
    kind: 'plugin-sandbox-status',
    status: 'blocked',
    executionReady: false,
    pluginCodeExecuted: false,
    cacheScope: 'host-session',
    observedAtLocal,
    probeAvailable,
    hardControls: Object.fromEntries(PLUGIN_SANDBOX_HARD_CONTROLS.map((key) => [key, false])),
    bestEffortEvidence,
    missingHardControls: [...PLUGIN_SANDBOX_HARD_CONTROLS],
    reasonCode: !probeAvailable
      ? 'PROBE_UNAVAILABLE'
      : canariesPassed ? 'BEST_EFFORT_CANARIES_PASSED' : 'BEST_EFFORT_CANARIES_INCOMPLETE',
  });
}

export function validatePluginSandboxStatus(value) {
  const keys = [
    'schemaVersion', 'kind', 'status', 'executionReady', 'pluginCodeExecuted',
    'cacheScope', 'observedAtLocal', 'probeAvailable', 'hardControls',
    'bestEffortEvidence', 'missingHardControls', 'reasonCode',
  ];
  const valid = exactObject(value, keys)
    && value.schemaVersion === 1
    && value.kind === 'plugin-sandbox-status'
    && value.status === 'blocked'
    && value.executionReady === false
    && value.pluginCodeExecuted === false
    && value.cacheScope === 'host-session'
    && canonicalTimestamp(value.observedAtLocal)
    && typeof value.probeAvailable === 'boolean'
    && exactBooleanRecord(value.hardControls, PLUGIN_SANDBOX_HARD_CONTROLS)
    && PLUGIN_SANDBOX_HARD_CONTROLS.every((key) => value.hardControls[key] === false)
    && exactBooleanRecord(value.bestEffortEvidence, PLUGIN_SANDBOX_BEST_EFFORT_EVIDENCE)
    && Array.isArray(value.missingHardControls)
    && value.missingHardControls.length === PLUGIN_SANDBOX_HARD_CONTROLS.length
    && value.missingHardControls.every((key, index) => key === PLUGIN_SANDBOX_HARD_CONTROLS[index])
    && REASON_CODES.has(value.reasonCode);
  if (!valid) throw new TypeError('The local host returned an invalid plugin sandbox status.');
  return freezeTree(structuredClone(value));
}
