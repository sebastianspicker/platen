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

test('plugin sandbox status service supports caller-supplied abort signals', async () => {
  let calls = 0;
  const service = new PluginSandboxStatusService({
    runner: async () => ({}),
    inspect: async () => {
      calls += 1;
      return { available: true, bestEffort: { sandboxBehaviorProbe: true, filesystemWriteDenied: true } };
    },
  });
  const statuses = await Promise.all([
    service.getStatus(),
    service.getStatus({ signal: new AbortController().signal }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(statuses[0], statuses[1]);
});

test('plugin sandbox status service validates exact options and abort signal type', () => {
  const service = new PluginSandboxStatusService({
    runner: async () => ({}),
    inspect: async () => ({}),
  });
  assert.throws(() => service.getStatus(null), TypeError);
  assert.throws(() => service.getStatus({ signal: 'invalid' }), TypeError);
  assert.throws(() => service.getStatus({ signal: new AbortController().signal, extra: true }), TypeError);
});

test('plugin sandbox status service rejects pre-cancelled requests without probing', async () => {
  let calls = 0;
  const service = new PluginSandboxStatusService({
    runner: async () => ({}),
    inspect: async () => {
      calls += 1;
      return { available: true, bestEffort: { sandboxBehaviorProbe: true } };
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.getStatus({ signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.equal(calls, 0);
});

test('plugin sandbox status service does not poison shared probe when one waiter is cancelled', async () => {
  let calls = 0;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const service = new PluginSandboxStatusService({
    runner: async () => ({}),
    inspect: async () => {
      calls += 1;
      await wait;
      return {
        available: true,
        bestEffort: {
          sandboxBehaviorProbe: true,
          filesystemWriteDenied: true,
          sensitiveFilesystemReadDenied: false,
          networkCanaryDenied: false,
          processForkCanaryDenied: false,
          nodePermissionProbe: true,
          cpuLimitCanary: true,
          jitless: false,
        },
      };
    },
  });
  const controller = new AbortController();
  const cancelled = service.getStatus({ signal: controller.signal });
  const active = service.getStatus();
  controller.abort();
  release();
  const [first, second] = await Promise.allSettled([cancelled, active]);
  assert.equal(first.status, 'rejected');
  assert.equal(first.reason?.code, 'JOB_CANCELLED');
  assert.equal(first.reason?.status, 499);
  assert.equal(second.status, 'fulfilled');
  assert.equal(second.value.status, 'blocked');
  assert.equal(calls, 1);
  assert.deepEqual(await service.getStatus(), second.value);
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
