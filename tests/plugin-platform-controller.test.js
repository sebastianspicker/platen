import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginPlatformController } from '../src/controllers/plugin-platform-controller.js';
import { createBlockedPluginSandboxStatus } from '../src/core/plugin-sandbox-status-contract.js';

const observedAtLocal = '2026-07-19T12:00:00.000Z';

function harness({ runPluginSandboxProbe } = {}) {
  const calls = [];
  const state = { probeResult: null, pluginSandboxStatus: null, error: 'stale' };
  const controller = createPluginPlatformController({
    state,
    client: { runPluginSandboxProbe },
    connectLocalHost: async () => { calls.push('connect'); },
    render: () => { calls.push(['render', state.probeResult]); },
    announce: (message) => { calls.push(['announce', message]); },
    showError: (error) => { state.error = error.message; calls.push(['error', error.message]); },
  });
  return { calls, controller, state };
}

test('plugin platform controller records diagnostic evidence without opening execution', async () => {
  const status = createBlockedPluginSandboxStatus({
    available: true,
    bestEffort: Object.fromEntries([
      'sandboxBehaviorProbe', 'filesystemWriteDenied', 'sensitiveFilesystemReadDenied',
      'networkCanaryDenied', 'processForkCanaryDenied', 'nodePermissionProbe',
      'cpuLimitCanary', 'jitless',
    ].map((key) => [key, true])),
  }, { observedAtLocal });
  const { calls, controller, state } = harness({ runPluginSandboxProbe: async () => status });
  assert.equal(await controller.inspectSandbox(), status);
  assert.equal(state.probeResult, 'blocked');
  assert.equal(state.pluginSandboxStatus.executionReady, false);
  assert.equal(state.error, null);
  assert.deepEqual(calls.slice(0, 2), [['render', 'checking'], 'connect']);
  assert.match(calls.find(([kind]) => kind === 'announce')[1], /hard gate remains closed/u);
});

test('plugin platform controller coalesces UI requests while the host probe is pending', async () => {
  let release;
  let calls = 0;
  const wait = new Promise((resolve) => { release = resolve; });
  const status = createBlockedPluginSandboxStatus(null, { observedAtLocal });
  const harnessResult = harness({
    runPluginSandboxProbe: async () => { calls += 1; await wait; return status; },
  });
  const first = harnessResult.controller.inspectSandbox();
  await Promise.resolve();
  assert.equal(await harnessResult.controller.inspectSandbox(), null);
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal(harnessResult.state.probeResult, 'blocked');
});

test('plugin platform controller fails closed and reports host errors', async () => {
  const { controller, state, calls } = harness({
    runPluginSandboxProbe: async () => { throw new Error('Probe unavailable.'); },
  });
  assert.equal(await controller.inspectSandbox(), null);
  assert.equal(state.probeResult, 'failed');
  assert.equal(state.pluginSandboxStatus, null);
  assert.equal(state.error, 'Probe unavailable.');
  assert.deepEqual(calls.at(-1), ['error', 'Probe unavailable.']);
});
