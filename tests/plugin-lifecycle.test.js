import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectPluginExecutionGate, PluginHost, PLUGIN_EXECUTION_BEST_EFFORT_EVIDENCE,
  PLUGIN_EXECUTION_REQUIREMENTS,
} from '../src/core/plugin-host.js';

function manifest(overrides = {}) {
  return {
    manifestVersion: 2,
    id: 'org.platen.example',
    name: 'Example',
    version: '1.0.0',
    protocolVersion: 1,
    entry: 'plugin.mjs',
    capabilities: ['example.inspect'],
    permissions: [{ name: 'document.metadata', reason: 'Read document properties.' }],
    dependencies: [],
    activation: 'manual',
    ...overrides,
  };
}

test('execution gate requires every native containment control', () => {
  const closed = inspectPluginExecutionGate({ signedPackage: true });
  assert.equal(closed.ready, false);
  assert.equal(closed.missing.includes('osSandbox'), true);
  assert.equal(closed.missing.includes('hardMemoryQuota'), true);
  const complete = inspectPluginExecutionGate(Object.fromEntries(PLUGIN_EXECUTION_REQUIREMENTS.map((key) => [key, true])));
  assert.equal(complete.ready, true);
  assert.deepEqual(complete.missing, []);
});

test('aggregate and best-effort resource evidence cannot satisfy hard quota requirements', () => {
  const evidence = Object.fromEntries(PLUGIN_EXECUTION_REQUIREMENTS.map((key) => [key, true]));
  delete evidence.hardMemoryQuota;
  evidence.resourceQuotas = true;
  evidence.rssWatchdog = true;
  evidence.v8HeapLimit = true;
  evidence.sandboxBehaviorProbe = true;
  const gate = inspectPluginExecutionGate(evidence);
  assert.equal(gate.ready, false);
  assert.deepEqual(gate.missing, ['hardMemoryQuota']);
  assert.deepEqual(gate.observedBestEffort, PLUGIN_EXECUTION_BEST_EFFORT_EVIDENCE);
});

test('host registers future contracts but fails closed on executable activation', async () => {
  const host = new PluginHost();
  host.register(manifest());
  await assert.rejects(() => host.activate('org.platen.example'), { code: 'PLUGIN_RUNTIME_UNAVAILABLE' });
  assert.equal(host.status('org.platen.example').state, 'blocked');
  assert.equal((await host.deactivate('org.platen.example')).state, 'unavailable');
});

test('injected frame adapters cannot bypass disabled runtime', async () => {
  let created = 0;
  const host = new PluginHost({
    frameFactory: { create: async () => { created += 1; } },
  });
  host.register(manifest());
  await assert.rejects(() => host.activate('org.platen.example'), { code: 'PLUGIN_RUNTIME_UNAVAILABLE' });
  assert.equal(created, 0);
});

test('unregistered plugin activation fails closed', async () => {
  const host = new PluginHost();
  await assert.rejects(() => host.activate('org.platen.example'), { code: 'DEPENDENCY_MISSING' });
});
