import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginRuntimeAuthorityRegistry } from '../scripts/host/plugin-runtime-authority-registry.mjs';

const pluginId = 'org.platen.runtime';
const oldDigest = 'a'.repeat(64);
const nextDigest = 'b'.repeat(64);

function binding(overrides = {}) {
  return Object.freeze({
    pluginId, version: '1.0.0', packageHash: oldDigest,
    activationId: 'activation_abcdefghijklmnop', operationId: 'operation_abcdefghijklmnop',
    nonce: 'c'.repeat(64), ...overrides,
  });
}

test('package transition terminates old runtime authority before commit', async () => {
  const calls = [];
  let active = { id: pluginId, version: '1.0.0', digest: oldDigest };
  const registry = new PluginRuntimeAuthorityRegistry({
    resolveActivation: async () => active,
    audit: (event) => calls.push(event.type),
  });
  const lease = await registry.register({
    binding: binding(),
    terminate: async (reason) => calls.push(`terminate:${reason}`),
  });
  assert.equal(registry.activeCount, 1);
  await registry.transition({
    id: pluginId,
    previous: { version: '1.0.0', digest: oldDigest },
    next: { version: '2.0.0', digest: nextDigest },
    reason: 'activation',
    commit: async () => { calls.push('commit'); active = { id: pluginId, version: '2.0.0', digest: nextDigest }; },
  });
  assert.deepEqual(calls, ['terminate:package-activation', 'plugin.package.transition', 'commit']);
  assert.equal(registry.activeCount, 0);
  assert.equal(await lease.release(), true);
});

test('failed runtime termination aborts package transition', async () => {
  let committed = false; let shouldFail = true;
  const registry = new PluginRuntimeAuthorityRegistry({
    resolveActivation: async () => ({ id: pluginId, version: '1.0.0', digest: oldDigest }),
  });
  await registry.register({ binding: binding(), terminate: async () => { if (shouldFail) throw new Error('kill failed'); } });
  const transition = () => registry.transition({
    id: pluginId,
    previous: { version: '1.0.0', digest: oldDigest },
    next: { version: '2.0.0', digest: nextDigest },
    reason: 'rollback',
    commit: async () => { committed = true; },
  });
  await assert.rejects(transition(), { code: 'PLUGIN_RUNTIME_TRANSITION_FAILED', status: 500 });
  assert.equal(committed, false);
  assert.equal(registry.activeCount, 1);
  await assert.rejects(registry.register({
    binding: binding({ activationId: 'activation_ponmlkjihgfedcba' }), terminate: async () => {},
  }), { code: 'PLUGIN_RUNTIME_QUARANTINED', status: 503 });
  await assert.rejects(transition(), { code: 'PLUGIN_RUNTIME_TRANSITION_FAILED', status: 500 });
  shouldFail = false;
  await transition();
  assert.equal(committed, true);
  assert.equal(registry.activeCount, 0);
});

test('runtime registration rejects a stale active package binding', async () => {
  const registry = new PluginRuntimeAuthorityRegistry({
    resolveActivation: async () => ({ id: pluginId, version: '2.0.0', digest: nextDigest }),
  });
  await assert.rejects(registry.register({ binding: binding(), terminate: async () => {} }), {
    code: 'PLUGIN_ACTIVATION_CHANGED', status: 409,
  });
  assert.equal(registry.activeCount, 0);
});
