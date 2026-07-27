import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { createBlockedPluginSandboxStatus } from '../src/core/plugin-sandbox-status-contract.js';

const token = 'a'.repeat(64);
const observedAtLocal = '2026-07-19T12:00:00.000Z';

test('local host client requests and validates the fixed plugin sandbox diagnostic', async () => {
  const calls = [];
  const status = createBlockedPluginSandboxStatus({
    available: true,
    bestEffort: { sandboxBehaviorProbe: true },
  }, { observedAtLocal });
  const client = new LocalHostClient({
    fetchImpl: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
      }
      return new Response(JSON.stringify(status), { status: 200 });
    },
  });
  await client.bootstrap();
  const controller = new AbortController();
  const result = await client.runPluginSandboxProbe({ signal: controller.signal });
  assert.deepEqual(result, status);
  assert.equal(Object.isFrozen(result.bestEffortEvidence), true);
  assert.equal(calls[1].path, '/api/plugin-sandbox-probe');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), {});
  assert.equal(calls[1].options.signal, controller.signal);
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
});

test('plugin sandbox client rejects caller evidence and invalid host promotion', async () => {
  const status = createBlockedPluginSandboxStatus(null, { observedAtLocal });
  const client = new LocalHostClient({
    fetchImpl: async (path) => path === '/api/bootstrap'
      ? new Response(JSON.stringify({ sessionToken: token }), { status: 200 })
      : new Response(JSON.stringify({ ...status, executionReady: true }), { status: 200 }),
  });
  await client.bootstrap();
  assert.throws(
    () => client.runPluginSandboxProbe({ evidence: { osSandbox: true } }),
    /probe options are invalid/u,
  );
  await assert.rejects(() => client.runPluginSandboxProbe(), /invalid plugin sandbox status/u);
});
