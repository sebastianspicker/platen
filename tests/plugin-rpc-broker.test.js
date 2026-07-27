import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PluginRpcSession, decodePluginRpcFrame, encodePluginRpcFrame, maxRpcReadRangeBytes,
} from '../scripts/host/plugin-rpc-broker.mjs';

const binding = Object.freeze({
  pluginId: 'org.platen.example',
  version: '1.0.0',
  packageHash: 'a'.repeat(64),
  activationId: 'activation_1234567890',
  operationId: 'operation_1234567890',
  nonce: 'b'.repeat(64),
});
const handle = `pdfh_${'c'.repeat(64)}`;

function request(sequence = 1, overrides = {}) {
  return {
    protocol: 1,
    nonce: binding.nonce,
    pluginId: binding.pluginId,
    version: binding.version,
    packageHash: binding.packageHash,
    activationId: binding.activationId,
    type: 'request',
    id: `request_${sequence}`,
    sequence,
    method: 'document.getMetadata',
    params: { handle },
    ...overrides,
  };
}

function session(overrides = {}) {
  const handles = {
    async getMetadata() { return { displayName: 'safe.pdf', size: 42, sha256: 'd'.repeat(64) }; },
    async readRange(_handle, { length }) { return Buffer.alloc(length, 0x41); },
  };
  return new PluginRpcSession({ binding, handles, ...overrides });
}

test('length-prefixed RPC rejects oversized prefixes, truncation, invalid UTF-8, and unsafe shapes', () => {
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(65_537);
  assert.throws(() => decodePluginRpcFrame(oversized), { code: 'PLUGIN_RPC_FRAME_TOO_LARGE' });

  const truncated = Buffer.alloc(5);
  truncated.writeUInt32BE(2);
  truncated[4] = 0x7b;
  assert.throws(() => decodePluginRpcFrame(truncated), { code: 'PLUGIN_RPC_TRUNCATED' });

  const invalidUtf8 = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
  assert.throws(() => decodePluginRpcFrame(invalidUtf8), { code: 'PLUGIN_RPC_INVALID_UTF8' });

  const unsafe = Buffer.from('{"constructor":{}}');
  const unsafeFrame = Buffer.alloc(unsafe.length + 4);
  unsafeFrame.writeUInt32BE(unsafe.length);
  unsafe.copy(unsafeFrame, 4);
  assert.throws(() => decodePluginRpcFrame(unsafeFrame), { code: 'PLUGIN_RPC_INVALID' });
});

test('RPC session binds every request and enforces sequence and replay controls', async () => {
  const broker = session();
  const result = decodePluginRpcFrame(await broker.processFrame(encodePluginRpcFrame(request())));
  assert.equal(result.type, 'result');
  assert.equal(result.value.displayName, 'safe.pdf');
  assert.equal(result.packageHash, binding.packageHash);
  assert.equal(result.activationId, binding.activationId);
  assert.equal(result.nonce, binding.nonce);

  await assert.rejects(
    broker.processFrame(encodePluginRpcFrame(request(3))),
    { code: 'PLUGIN_RPC_SEQUENCE_INVALID' },
  );
  await assert.rejects(
    session().processFrame(encodePluginRpcFrame(request(1, { packageHash: 'e'.repeat(64) }))),
    { code: 'PLUGIN_RPC_BINDING_MISMATCH' },
  );
});

test('RPC rejects ranges that cannot fit before consuming document authority', async () => {
  let reads = 0;
  const handles = {
    async getMetadata() { return {}; },
    async readRange(_handle, { length }) { reads += 1; return Buffer.alloc(length); },
  };
  const broker = new PluginRpcSession({ binding, handles });
  const probe = request(1, {
    method: 'document.readRange', params: { handle, offset: 0, length: 1 },
  });
  const maximum = maxRpcReadRangeBytes(probe);
  await assert.rejects(
    broker.processFrame(encodePluginRpcFrame({ ...probe, params: { ...probe.params, length: maximum + 1 } })),
    { code: 'PLUGIN_RPC_RESULT_BUDGET' },
  );
  assert.equal(reads, 0);

  const accepted = new PluginRpcSession({ binding, handles });
  const result = decodePluginRpcFrame(await accepted.processFrame(encodePluginRpcFrame({
    ...probe, params: { ...probe.params, length: maximum },
  })));
  assert.equal(result.value.byteLength, maximum);
  assert.equal(reads, 1);
});

test('RPC request deadline returns a bound sanitized error frame', async () => {
  const handles = {
    async getMetadata() { return new Promise(() => {}); },
    async readRange() { return Buffer.alloc(1); },
  };
  const broker = new PluginRpcSession({ binding, handles, limits: { requestTimeoutMs: 10 } });
  const result = decodePluginRpcFrame(await broker.processFrame(encodePluginRpcFrame(request(1))));
  assert.equal(result.type, 'error');
  assert.equal(result.error.code, 'PLUGIN_REQUEST_TIMEOUT');
  assert.equal(result.pluginId, binding.pluginId);
});

test('RPC method dispatcher validates params and base64-encodes bounded document bytes', async () => {
  const broker = session();
  const range = request(1, {
    method: 'document.readRange',
    params: { handle, offset: 2, length: 4 },
  });
  const result = decodePluginRpcFrame(await broker.processFrame(encodePluginRpcFrame(range)));
  assert.deepEqual(result.value, { encoding: 'base64', byteLength: 4, data: 'QUFBQQ==' });

  await assert.rejects(
    session().processFrame(encodePluginRpcFrame(request(1, { method: 'network.fetch', params: { handle } }))),
    { code: 'PLUGIN_RPC_METHOD_UNKNOWN' },
  );
});

test('RPC rate, in-flight, result, and lifecycle limits fail closed', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const handles = {
    async getMetadata() { await blocked; return { ok: true }; },
    async readRange() { return Buffer.alloc(1); },
  };
  let closed = null;
  const broker = new PluginRpcSession({
    binding, handles, limits: { maxInFlight: 1, maxRequestsPerMinute: 4 },
    onClose: (event) => { closed = event; },
  });
  const first = broker.processFrame(encodePluginRpcFrame(request(1)));
  await assert.rejects(
    broker.processFrame(encodePluginRpcFrame(request(2))),
    { code: 'PLUGIN_RPC_INFLIGHT_LIMIT' },
  );
  release();
  assert.equal(decodePluginRpcFrame(await first).type, 'result');
  assert.equal(broker.close('test-complete'), true);
  assert.equal(closed.activationId, binding.activationId);
  await assert.rejects(broker.processFrame(encodePluginRpcFrame(request(3))), { code: 'PLUGIN_RPC_SESSION_CLOSED' });

  const oversizedResult = session({ limits: { maxResultBytes: 128 } });
  await assert.rejects(
    oversizedResult.processFrame(encodePluginRpcFrame(request(1))),
    { code: 'PLUGIN_RPC_FRAME_TOO_LARGE' },
  );
});
