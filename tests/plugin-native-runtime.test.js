import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PluginNativeRuntime,
  PLUGIN_NATIVE_HARD_ATTESTATION_FIELDS,
} from '../scripts/host/plugin-native-runtime.mjs';
import {
  decodePluginWorkerControl,
  encodePluginWorkerControl,
} from '../scripts/host/plugin-worker-control.mjs';

const pluginId = 'org.platen.native';
const packageHash = 'a'.repeat(64);
const source = Buffer.from('registerPlugin({invoke(input) { return input; }});');
const sourceSha256 = createHash('sha256').update(source).digest('hex');

function descriptor() {
  return Object.freeze({
    id: pluginId, version: '1.0.0', digest: packageHash, packageHash,
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

function fullEvidence(overrides = {}) {
  return Object.freeze({
    schema: 'pdf-plugin-native-attestation-v1', version: 1,
    pluginId, pluginVersion: '1.0.0', packageHash, sourceSha256,
    supervisorPid: 101, workerPid: 102, teamIdentifier: 'ABCDE12345',
    supervisorCdHash: '1'.repeat(40), workerCdHash: '2'.repeat(40),
    designatedRequirementSha256: '3'.repeat(64),
    ...Object.fromEntries(PLUGIN_NATIVE_HARD_ATTESTATION_FIELDS.map((field) => [field, true])),
    ...overrides,
  });
}

function fixture({
  evidence = fullEvidence(), launchError = null, invokeError = null,
  workerResult = 'completion', transitionDuringInvoke = false,
} = {}) {
  const calls = [];
  let registeredTermination = null;
  const packages = {
    async getExecutableLaunch() {
      calls.push('package');
      return Object.freeze({ descriptor: descriptor(), source: Buffer.from(source) });
    },
  };
  const grants = {
    async issue() { calls.push('grant'); return { grantId: 'grant' }; },
    revokeActivation() { calls.push('revoke-grant'); return 1; },
  };
  const handles = {
    issue() { calls.push('handle'); return { handle: `pdfh_${'c'.repeat(64)}` }; },
    async getMetadata() { return {}; }, async readRange() { return Buffer.alloc(1); },
    revokeActivation() { calls.push('revoke-handle'); return 1; },
  };
  const supervisor = {
    async launch({ source: delivered }) {
      calls.push('launch');
      assert.notEqual(delivered, source);
      if (launchError) throw launchError;
      return {
        evidence,
        async invoke(options) {
          calls.push('invoke');
          if (invokeError) throw invokeError;
          if (transitionDuringInvoke) await registeredTermination('package-rollback');
          assert.deepEqual(Object.keys(options).sort(), ['control', 'rpc', 'signal']);
          assert.deepEqual(Object.keys(options.rpc).sort(), ['close', 'maxConcurrentRequests', 'processFrame']);
          assert.doesNotMatch(JSON.stringify(options), /packageRoot|entryPath|documentId|grantId/u);
          const raw = JSON.parse(options.control.toString('utf8'));
          const binding = Object.freeze({
            pluginId: raw.pluginId, version: raw.version, packageHash: raw.packageHash,
            activationId: raw.activationId, operationId: raw.operationId, nonce: raw.nonce,
          });
          const request = decodePluginWorkerControl(options.control, { binding });
          const response = workerResult === 'completion'
            ? { ...request, type: 'completion', result: { accepted: true } }
            : { ...request, type: 'failure', failure: { code: 'PLUGIN_WORKER_FAILED', message: 'The plugin operation could not be completed.' } };
          delete response.capability; delete response.documentHandle; delete response.input;
          return encodePluginWorkerControl(response, { binding });
        },
        async close() { calls.push('close-worker'); },
      };
    },
  };
  const activations = {
    async register({ terminate }) {
      calls.push('register-runtime');
      registeredTermination = terminate;
      return { async release() { calls.push('release-runtime'); return true; }, terminate };
    },
  };
  const createSession = async ({ audit, grants: grantAuthority, handles: handleAuthority }) => {
    calls.push('session');
    await grantAuthority.issue();
    handleAuthority.issue();
    const binding = Object.freeze({
      pluginId, version: '1.0.0', packageHash,
      activationId: 'activation_abcdefghijklmnop', operationId: 'operation_abcdefghijklmnop', nonce: 'd'.repeat(64),
    });
    audit({ type: 'plugin.operation.opened' });
    return {
      binding,
      processFrame() {},
      maxConcurrentRequests: 4,
      createInvocation(capability, input) {
        return { protocol: 1, ...binding, type: 'invoke', capability, documentHandle: `pdfh_${'c'.repeat(64)}`, input };
      },
      close() { calls.push('close-session'); return true; },
    };
  };
  return { calls, packages, grants, handles, supervisor, activations, createSession };
}

function runtime(setup, audit = () => {}) {
  return new PluginNativeRuntime({ ...setup, audit });
}

const request = Object.freeze({
  pluginId, documentId: 'private-document', permissions: ['document.metadata'],
  methods: ['document.getMetadata'], capability: 'document.example', input: { page: 1 },
});

test('native runtime attests the live worker before issuing any operation authority', async () => {
  const setup = fixture();
  const events = [];
  const result = await runtime(setup, (event) => events.push(event.type)).invoke(request);
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(setup.calls, [
    'package', 'launch', 'session', 'grant', 'handle', 'register-runtime', 'invoke',
    'close-session', 'close-worker', 'release-runtime',
  ]);
  assert.deepEqual(events, ['plugin.native-worker.attested', 'plugin.operation.opened', 'plugin.native-worker.completed']);
});

test('failed or incomplete native attestation cannot create grants or handles', async () => {
  const unsafeLaunch = fixture({ launchError: new Error('/private/store/index.js failed with secret argv') });
  await assert.rejects(runtime(unsafeLaunch).invoke(request), (error) => {
    assert.equal(error.code, 'PLUGIN_NATIVE_LAUNCH_FAILED');
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /private|index[.]js|argv/u);
    return true;
  });
  for (const setup of [unsafeLaunch, fixture({ evidence: fullEvidence({ appSandbox: false }) })]) {
    if (setup !== unsafeLaunch) await assert.rejects(runtime(setup).invoke(request));
    assert.equal(setup.calls.includes('session'), false);
    assert.equal(setup.calls.includes('grant'), false);
    assert.equal(setup.calls.includes('handle'), false);
  }
  const rejectedAttestation = fixture({ evidence: fullEvidence({ hardMemoryQuota: false }) });
  await assert.rejects(runtime(rejectedAttestation).invoke(request), {
    code: 'PLUGIN_NATIVE_ATTESTATION_FAILED', status: 503,
  });
  assert.deepEqual(rejectedAttestation.calls, ['package', 'launch', 'close-worker']);
});

test('manifest-v2 and malformed executable launch records fail before supervisor launch', async () => {
  const setup = fixture();
  setup.packages.getExecutableLaunch = async () => ({
    descriptor: { ...descriptor(), executableRuntime: null }, source: Buffer.from(source),
  });
  await assert.rejects(runtime(setup).invoke(request), { code: 'PLUGIN_LAUNCH_DESCRIPTOR_INVALID', status: 500 });
  assert.deepEqual(setup.calls, []);
});

test('worker failure is sanitized and closes operation authority before process teardown', async () => {
  const setup = fixture({ workerResult: 'failure' });
  await assert.rejects(runtime(setup).invoke(request), { code: 'PLUGIN_WORKER_FAILED', status: 500 });
  assert.deepEqual(setup.calls.slice(-3), ['close-session', 'close-worker', 'release-runtime']);
});

test('raw native invocation failures are sanitized before leaving the host boundary', async () => {
  const setup = fixture({ invokeError: new Error('/private/source.js leaked secret argv') });
  await assert.rejects(runtime(setup).invoke(request), (error) => {
    assert.equal(error.code, 'PLUGIN_WORKER_FAILED');
    assert.equal(error.status, 500);
    assert.doesNotMatch(error.message, /private|source[.]js|argv/u);
    return true;
  });
  assert.deepEqual(setup.calls.slice(-3), ['close-session', 'close-worker', 'release-runtime']);
});

test('package transition racing an invocation shares one idempotent teardown', async () => {
  const setup = fixture({ transitionDuringInvoke: true });
  assert.deepEqual(await runtime(setup).invoke(request), { accepted: true });
  assert.equal(setup.calls.filter((value) => value === 'close-session').length, 1);
  assert.equal(setup.calls.filter((value) => value === 'close-worker').length, 1);
});

test('aborted invocation is rejected before package or process access', async () => {
  const setup = fixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime(setup).invoke({ ...request, signal: controller.signal }), {
    code: 'PLUGIN_WORKER_CANCELLED', status: 499,
  });
  assert.deepEqual(setup.calls, []);
});
