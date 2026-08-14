import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBlockedPluginSandboxStatus,
  validatePluginSandboxStatus,
} from '../src/core/plugin-sandbox-status-contract.js';

const observedAtLocal = '2026-07-19T12:00:00.000Z';

test('public plugin sandbox status keeps hard gates closed despite passing canaries', () => {
  const status = createBlockedPluginSandboxStatus({
    available: true,
    bestEffort: {
      sandboxBehaviorProbe: true,
      filesystemWriteDenied: true,
      sensitiveFilesystemReadDenied: true,
      networkCanaryDenied: true,
      processForkCanaryDenied: true,
      nodePermissionProbe: true,
      cpuLimitCanary: true,
      jitless: true,
    },
    observed: { path: '/private/secret', stderr: 'must not cross the boundary' },
  }, { observedAtLocal });
  assert.equal(status.reasonCode, 'BEST_EFFORT_CANARIES_PASSED');
  assert.equal(Object.values(status.hardControls).every((value) => value === false), true);
  assert.equal(status.executionReady, false);
  assert.equal(status.pluginCodeExecuted, false);
  assert.doesNotMatch(JSON.stringify(status), /private|stderr|secret/u);
  assert.equal(Object.isFrozen(status.bestEffortEvidence), true);
});

test('unavailable or incomplete probes produce only coarse blocked evidence', () => {
  const unavailable = createBlockedPluginSandboxStatus(null, { observedAtLocal });
  assert.equal(unavailable.reasonCode, 'PROBE_UNAVAILABLE');
  assert.equal(unavailable.probeAvailable, false);
  const incomplete = createBlockedPluginSandboxStatus({
    available: true,
    bestEffort: { sandboxBehaviorProbe: true },
  }, { observedAtLocal });
  assert.equal(incomplete.reasonCode, 'BEST_EFFORT_CANARIES_INCOMPLETE');
  assert.equal(incomplete.bestEffortEvidence.sandboxBehaviorProbe, true);
  assert.equal(incomplete.bestEffortEvidence.cpuLimitCanary, false);
});

test('plugin sandbox status validator rejects promoted hard gates and unknown fields', () => {
  const status = createBlockedPluginSandboxStatus(null, { observedAtLocal });
  assert.deepEqual(validatePluginSandboxStatus(status), status);
  assert.throws(() => validatePluginSandboxStatus({
    ...status,
    executionReady: true,
  }), /invalid plugin sandbox status/u);
  assert.throws(() => validatePluginSandboxStatus({
    ...status,
    rawProfile: '(allow default)',
  }), /invalid plugin sandbox status/u);
});
