import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { PluginNativeSupervisor } from '../scripts/host/plugin-native-supervisor.mjs';
import { nativeDesignatedRequirements } from '../scripts/host/plugin-native-supervisor-contract.mjs';
import {
  NativeSupervisorProcess,
  spawnNativeSupervisor,
} from '../scripts/host/plugin-native-supervisor-process.mjs';

const source = Buffer.from('registerPlugin({invoke: (input) => input});');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const team = 'ABCDE12345';
const requirements = nativeDesignatedRequirements(team);
const supervisor = Object.freeze({ executable: '/private/release/PDFPluginSupervisor', sha256: 'a'.repeat(64) });
const worker = Object.freeze({ executable: '/private/release/PDFPluginWorker', sha256: 'b'.repeat(64) });
const policy = Object.freeze({
  schema: 'pdf-plugin-native-release-policy-v1', version: 1, teamIdentifier: team,
  supervisorSha256: supervisor.sha256, workerSha256: worker.sha256,
  supervisorCdHash: 'c'.repeat(40), workerCdHash: 'd'.repeat(40),
  designatedRequirementSha256: requirements.sha256,
});
const identity = Object.freeze({
  pluginId: 'org.platen.adapter', version: '1.0.0', packageHash: 'e'.repeat(64), sourceSha256,
  runtime: Object.freeze({ kind: 'javascriptcore-classic-script', apiVersion: 1, entry: 'index.js', sha256: sourceSha256 }),
});
const hard = [
  'staticCodeIdentity', 'liveCodeIdentity', 'appSandbox', 'noNetwork', 'cpuQuota', 'hardMemoryQuota',
  'processQuota', 'outputQuota', 'privateIpc', 'sourceBytesOnly',
];

function canonical(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function frame(value) {
  const payload = Buffer.from(canonical(value)); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

function ready(overrides = {}) {
  return frame({
    schema: 'pdf-plugin-native-attestation-v1', protocol: 1, type: 'ready',
    pluginId: identity.pluginId, pluginVersion: identity.version, packageHash: identity.packageHash, sourceSha256,
    supervisorPid: 701, workerPid: 702, teamIdentifier: team, supervisorCdHash: policy.supervisorCdHash,
    workerCdHash: policy.workerCdHash, designatedRequirementSha256: policy.designatedRequirementSha256,
    ...Object.fromEntries(hard.map((name) => [name, true])), ...overrides,
  });
}

function fakeProcess(frames = [ready(), frame({ accepted: true })]) {
  const calls = []; let index = 0; let closeCount = 0;
  return {
    pid: 701, rpcReadable: {}, rpcWritable: {}, calls,
    async writePreparation(header, bytes) { calls.push(`prepare:${header.length}:${bytes.length}`); },
    async writeInvocation(header, bytes) { calls.push(`invoke:${header.length}:${bytes.length}`); },
    async nextFrame() { calls.push(`frame:${index}`); return frames[index++]; },
    assertReadyOnly() { calls.push('ready-only'); },
    beginInvocation() { calls.push('begin-invocation'); },
    async finish() { calls.push('finish'); return { code: 0 }; },
    async close(reason) { closeCount += 1; calls.push(`close:${reason}`); return true; },
    get closeCount() { return closeCount; },
  };
}

function adapter({ process = fakeProcess(), verifyError, codeIdentity, runRpc } = {}) {
  const verifier = codeIdentity ?? {
    async verifyStaticPair() {}, async verifyLiveSupervisor() {}, async verifyLiveWorker() {},
  };
  return new PluginNativeSupervisor({
    supervisor, worker, policy, codeIdentity: verifier,
    async verifyExecutable() { if (verifyError) throw verifyError; },
    async spawnProcess() { return process; },
    runRpc: runRpc ?? (async () => {}),
    limits: { launchTimeoutMs: 100, invokeTimeoutMs: 100, gracefulTerminationMs: 10, reapTimeoutMs: 10 },
  });
}

test('adapter starts private RPC before phase two and closes idempotently after completion', async () => {
  const process = fakeProcess(); const order = [];
  const launched = await adapter({ process, runRpc: async () => { order.push('rpc'); } }).launch({ identity, source });
  const completion = await launched.invoke({
    control: Buffer.from('{"invoke":true}'), signal: undefined,
    rpc: { maxConcurrentRequests: 1, processFrame() {}, close() {} },
  });
  assert.deepEqual(JSON.parse(completion), { accepted: true });
  assert.equal(order[0], 'rpc');
  assert.ok(process.calls.indexOf('frame:1') < process.calls.findIndex((entry) => entry.startsWith('invoke:')));
  assert.equal(process.calls.at(-1), 'finish');
  assert.equal(await launched.close(), false);
  assert.equal(process.closeCount, 0);
});

test('failed readiness attestation cleans up before any worker authority escapes', async () => {
  for (const invalid of [ready({ hardMemoryQuota: false }), ready({ workerPid: 701 })]) {
    const process = fakeProcess([invalid]);
    await assert.rejects(adapter({ process }).launch({ identity, source }), {
      code: 'PLUGIN_NATIVE_ATTESTATION_FAILED', status: 503,
    });
    assert.equal(process.closeCount, 1);
  }
});

test('artifact and native failures remain sanitized at the adapter boundary', async () => {
  await assert.rejects(adapter({ verifyError: new Error('/private/release/secret argv') }).launch({ identity, source }), (error) => {
    assert.equal(error.code, 'PLUGIN_NATIVE_ARTIFACT_INVALID');
    assert.doesNotMatch(error.message, /private|secret|argv/u);
    return true;
  });
  const process = fakeProcess();
  await assert.rejects(adapter({ process, codeIdentity: {
    async verifyStaticPair() {}, async verifyLiveSupervisor() { throw new Error('/private/pid leaked'); }, async verifyLiveWorker() {},
  } }).launch({ identity, source }), (error) => {
    assert.equal(error.code, 'PLUGIN_NATIVE_LAUNCH_FAILED');
    assert.doesNotMatch(error.message, /private|pid|leaked/u);
    return true;
  });
  assert.equal(process.closeCount, 1);
});

function childFixture(pid = 801) {
  const child = new EventEmitter();
  child.pid = pid; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
  child.kill = () => {}; return child;
}

test('process adapter rejects truncated and third stdout frames plus nonzero exits', async () => {
  const options = { killGroup() {}, probeGroup() { return false; } };
  const truncated = childFixture(); const first = new NativeSupervisorProcess({ child: truncated, ...options });
  truncated.stdout.end(Buffer.from([0, 0, 0, 3, 123]));
  await assert.rejects(first.nextFrame({ timeoutMs: 100, phase: 'ready' }), { code: 'PLUGIN_FRAME_TRUNCATED' });

  const extra = childFixture(); const second = new NativeSupervisorProcess({ child: extra, ...options });
  extra.stdout.write(frame({ one: 1 }));
  await second.nextFrame({ timeoutMs: 100, phase: 'ready' });
  second.assertReadyOnly(); second.beginInvocation();
  extra.stdout.end(Buffer.concat([frame({ two: 2 }), frame({ three: 3 })]));
  await assert.rejects(second.finish({ timeoutMs: 100 }), { code: 'PLUGIN_NATIVE_PROTOCOL_INVALID' });

  const badExit = childFixture(); const third = new NativeSupervisorProcess({ child: badExit, ...options });
  badExit.stdout.write(frame({ one: 1 }));
  await third.nextFrame({ timeoutMs: 100, phase: 'ready' });
  third.assertReadyOnly(); third.beginInvocation();
  badExit.stdout.end(frame({ two: 2 })); badExit.emit('close', 1, null);
  await assert.rejects(third.finish({ timeoutMs: 100 }), { code: 'PLUGIN_NATIVE_PROCESS_FAILED', status: 502 });
});

test('process close is concurrent-idempotent and reaps only once', async () => {
  const child = childFixture(); let kills = 0; let groupAlive = true;
  const process = new NativeSupervisorProcess({
    child,
    probeGroup() { return groupAlive; },
    killGroup() {
      kills += 1; groupAlive = false;
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    },
  });
  const [left, right] = await Promise.all([process.close('test'), process.close('test')]);
  assert.equal(left, true); assert.equal(right, true); assert.equal(kills, 1);
  assert.equal(await process.close('test'), false);
});

test('process close kills a surviving group after the supervisor leader closes', async () => {
  const child = childFixture(); const signals = []; let groupAlive = true;
  const process = new NativeSupervisorProcess({
    child,
    probeGroup() { return groupAlive; },
    killGroup(_pid, signal) {
      signals.push(signal);
      if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      else groupAlive = false;
    },
  });
  assert.equal(await process.close('orphan-proof', { graceMs: 5, reapMs: 50 }), true);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('process error evidence never substitutes for the close/reap event', async () => {
  const child = childFixture(); let groupAlive = true;
  const process = new NativeSupervisorProcess({
    child,
    probeGroup() { return groupAlive; },
    killGroup() {},
  });
  let settled = false;
  const closing = process.close('error-is-not-close', { graceMs: 20, reapMs: 20 })
    .then((value) => { settled = true; return value; });
  child.emit('error', new Error('spawn channel error'));
  await Promise.resolve();
  assert.equal(settled, false);
  groupAlive = false;
  child.emit('close', null, 'SIGTERM');
  assert.equal(await closing, true);
});

test('process rejects completion emitted before invocation begins', async () => {
  const child = childFixture();
  const process = new NativeSupervisorProcess({
    child,
    killGroup() {},
    probeGroup() { return false; },
  });
  child.stdout.write(Buffer.concat([frame({ ready: true }), frame({ accepted: true })]));
  await process.nextFrame({ timeoutMs: 100, phase: 'ready' });
  assert.throws(() => process.assertReadyOnly(), { code: 'PLUGIN_NATIVE_PROTOCOL_PHASE' });
  child.emit('close', 1, null);
});

test('spawn validation kills and reaps a detached child with malformed private pipes', async () => {
  const child = childFixture(); child.stdio = [child.stdin, child.stdout, child.stderr];
  const signals = []; let groupAlive = true;
  await assert.rejects(spawnNativeSupervisor({
    executable: '/private/release/PDFPluginSupervisor',
    spawnImpl() { return child; },
    probeGroup() { return groupAlive; },
    killGroup(_pid, signal) {
      signals.push(signal); groupAlive = false;
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    },
  }), { code: 'PLUGIN_NATIVE_SPAWN_FAILED', status: 503 });
  assert.deepEqual(signals, ['SIGKILL']);
});

test('spawn cleanup still kills an injected malformed child without event methods', async () => {
  const child = {
    pid: 802,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [],
    kill() {},
  };
  const signals = []; let groupAlive = true;
  await assert.rejects(spawnNativeSupervisor({
    executable: '/private/release/PDFPluginSupervisor',
    spawnImpl() { return child; },
    probeGroup() { return groupAlive; },
    killGroup(_pid, signal) { signals.push(signal); groupAlive = false; },
  }), { code: 'PLUGIN_NATIVE_SPAWN_FAILED', status: 503 });
  assert.deepEqual(signals, ['SIGKILL']);
});
