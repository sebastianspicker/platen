import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginSandboxStatusService } from '../scripts/host/plugin-sandbox-status-service.mjs';

test('plugin sandbox status service runs one concurrent host-session probe and exposes only blocked contract evidence', async () => {
  let calls = 0;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const runner = async () => ({ stdout: '', stderr: '', exitCode: 0 });
  const service = new PluginSandboxStatusService({
    runner,
    inspect: async ({ runner: actualRunner }) => {
      calls += 1;
      assert.equal(actualRunner, runner);
      await wait;
      return { available: true, bestEffort: { sandboxBehaviorProbe: true, filesystemWriteDenied: true } };
    },
  });
  const pending = [service.getStatus(), service.getStatus(), service.getStatus()];
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  const statuses = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.deepEqual(statuses[0], statuses[1]);
  assert.equal(statuses[0].executionReady, false);
  assert.equal(statuses[0].pluginCodeExecuted, false);
  assert.equal(statuses[0].hardControls.osSandbox, false);
  assert.equal(Object.hasOwn(statuses[0], 'rawProfile'), false);
  assert.deepEqual(await service.getStatus(), statuses[0]);
  assert.equal(calls, 1);
});

test('plugin sandbox status service sanitizes and caches synchronous probe failures', async () => {
  let calls = 0;
  const service = new PluginSandboxStatusService({
    runner: async () => {},
    inspect: () => {
      calls += 1;
      throw new Error('/private/secret argv stderr profile');
    },
  });
  const [status] = await Promise.all([service.getStatus(), service.getStatus()]);
  assert.equal(calls, 1);
  assert.equal(status.status, 'blocked');
  assert.equal(status.probeAvailable, false);
  assert.equal(status.reasonCode, 'PROBE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(status), /secret|argv|stderr|profile/u);
  await service.getStatus();
  assert.equal(calls, 1);
});
