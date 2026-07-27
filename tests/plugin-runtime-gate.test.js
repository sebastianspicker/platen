import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PLUGIN_EXECUTION_REQUIREMENTS } from '../src/core/plugin-host.js';
import { PluginNativeRuntime, PLUGIN_NATIVE_HARD_ATTESTATION_FIELDS } from '../scripts/host/plugin-native-runtime.mjs';
import { createPluginRuntimeGate } from '../scripts/host/plugin-runtime-gate.mjs';

const pluginId = 'org.platen.gate';
const source = Buffer.from('registerPlugin({invoke(input) { return input; }});');
const sourceSha256 = createHash('sha256').update(source).digest('hex');

function ready() {
  return Object.fromEntries(PLUGIN_EXECUTION_REQUIREMENTS.map((field) => [field, true]));
}

function descriptor() {
  return Object.freeze({
    id: pluginId, version: '1.0.0', digest: 'a'.repeat(64), packageHash: 'a'.repeat(64),
    manifest: Object.freeze({
      manifestVersion: 3, id: pluginId, version: '1.0.0', entry: 'index.js',
      capabilities: ['document.example'], dependencies: [],
      runtime: Object.freeze({ kind: 'javascriptcore-classic-script', apiVersion: 1 }),
    }),
    publisher: Object.freeze({ publisherId: 'org.platen', keyId: 'test' }),
    packageRoot: '/private/session/packages/signed',
    entryPath: '/private/session/packages/signed/index.js',
    inventory: Object.freeze([{
      path: 'index.js', mediaType: 'text/javascript', size: source.length, sha256: sourceSha256,
    }]),
    dependencies: Object.freeze([]),
    executableRuntime: Object.freeze({
      kind: 'javascriptcore-classic-script', apiVersion: 1, entry: 'index.js', sha256: sourceSha256,
    }),
  });
}

function failedEvidence() {
  return Object.freeze({
    schema: 'pdf-plugin-native-attestation-v1', version: 1,
    pluginId, pluginVersion: '1.0.0', packageHash: 'a'.repeat(64), sourceSha256,
    supervisorPid: 101, workerPid: 102, teamIdentifier: 'ABCDE12345',
    supervisorCdHash: '1'.repeat(40), workerCdHash: '2'.repeat(40),
    designatedRequirementSha256: '3'.repeat(64),
    ...Object.fromEntries(PLUGIN_NATIVE_HARD_ATTESTATION_FIELDS.map((field) => [field, field !== 'hardMemoryQuota'])),
  });
}

test('runtime gate is default-off and every missing, false, or non-data readiness field blocks construction', () => {
  let constructions = 0;
  const createRuntime = () => { constructions += 1; return {}; };
  assert.equal(createPluginRuntimeGate({ createRuntime }), null);
  for (const field of PLUGIN_EXECUTION_REQUIREMENTS) {
    const evidence = ready(); evidence[field] = false;
    assert.equal(createPluginRuntimeGate({ readiness: evidence, createRuntime }), null);
    delete evidence[field];
    assert.equal(createPluginRuntimeGate({ readiness: evidence, createRuntime }), null);
  }
  const accessor = ready();
  Object.defineProperty(accessor, 'rollback', { enumerable: true, get() { return true; } });
  assert.equal(createPluginRuntimeGate({ readiness: accessor, createRuntime }), null);
  const promoted = { ...ready(), rssWatchdog: true };
  assert.equal(createPluginRuntimeGate({ readiness: promoted, createRuntime }), null);
  assert.equal(constructions, 0);
});

test('an exact all-true host readiness record constructs the native runtime through one injectable seam', () => {
  const dependencies = {
    packages: { getExecutableLaunch() {} },
    grants: { issue() {}, revokeActivation() {} },
    handles: { issue() {}, getMetadata() {}, readRange() {}, revokeActivation() {} },
    supervisor: { launch() {} },
    activations: { register() {} },
  };
  let received = null;
  const runtime = createPluginRuntimeGate({
    readiness: ready(), ...dependencies,
    createRuntime: (options) => {
      received = options;
      return new PluginNativeRuntime(options);
    },
  });
  assert.ok(runtime instanceof PluginNativeRuntime);
  assert.equal(received.activations, dependencies.activations);
  assert.deepEqual(Object.keys(received).sort(), ['activations', 'audit', 'grants', 'handles', 'packages', 'supervisor']);
});

test('late worker attestation failure creates no grants, handles, or runtime registration', async () => {
  const calls = [];
  const runtime = createPluginRuntimeGate({
    readiness: ready(),
    packages: { async getExecutableLaunch() { return { descriptor: descriptor(), source: Buffer.from(source) }; } },
    grants: { async issue() { calls.push('grant'); }, revokeActivation() { calls.push('revoke-grant'); } },
    handles: {
      issue() { calls.push('handle'); }, async getMetadata() {}, async readRange() {},
      revokeActivation() { calls.push('revoke-handle'); },
    },
    supervisor: {
      async launch() {
        calls.push('launch');
        return { evidence: failedEvidence(), async invoke() {}, async close() { calls.push('close'); } };
      },
    },
    activations: { async register() { calls.push('register'); } },
  });
  await assert.rejects(runtime.invoke({ pluginId }), {
    code: 'PLUGIN_NATIVE_ATTESTATION_FAILED', status: 503,
  });
  assert.deepEqual(calls, ['launch', 'close']);
});
