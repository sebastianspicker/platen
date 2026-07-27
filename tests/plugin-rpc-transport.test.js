import assert from 'node:assert/strict';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';
import {
  decodePluginRpcFrame, encodePluginRpcFrame, PluginRpcSession,
} from '../scripts/host/plugin-rpc-broker.mjs';
import { runPluginRpcTransport } from '../scripts/host/plugin-rpc-transport.mjs';

function captureWritable() {
  const chunks = [];
  const writable = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  return { writable, chunks };
}

function sessionFixture() {
  const calls = { frames: [], close: [] };
  return {
    calls,
    session: {
      async processFrame(frame) {
        calls.frames.push(Buffer.from(frame));
        return encodePluginRpcFrame({ ok: true, sequence: calls.frames.length });
      },
      close(reason) { calls.close.push(reason); return calls.close.length === 1; },
    },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for the transport state.');
}

test('private transport preserves framing across chunks and closes authority at EOF', async () => {
  const first = encodePluginRpcFrame({ request: 1 });
  const second = encodePluginRpcFrame({ request: 2 });
  const readable = Readable.from([
    first.subarray(0, 2),
    Buffer.concat([first.subarray(2), second.subarray(0, 5)]),
    second.subarray(5),
  ]);
  const output = captureWritable();
  const setup = sessionFixture();
  const result = await runPluginRpcTransport({ readable, writable: output.writable, session: setup.session });
  assert.deepEqual(setup.calls.frames, [first, second]);
  assert.equal(output.chunks.length, 2);
  assert.deepEqual(result, {
    frameCount: 2,
    receivedBytes: first.length + second.length,
    writtenBytes: output.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    closeReason: 'transport-eof',
  });
  assert.deepEqual(setup.calls.close, ['transport-eof']);
});

test('truncated transport input fails and closes operation authority exactly once', async () => {
  const complete = encodePluginRpcFrame({ request: 1 });
  const readable = Readable.from([complete.subarray(0, complete.length - 1)]);
  const output = captureWritable();
  output.writable.on('error', () => {});
  const setup = sessionFixture();
  await assert.rejects(
    runPluginRpcTransport({ readable, writable: output.writable, session: setup.session }),
    { code: 'PLUGIN_FRAME_TRUNCATED' },
  );
  assert.deepEqual(setup.calls.close, ['transport-failed']);
});

test('transport cancellation destroys blocked input and revokes the operation', async () => {
  const readable = new PassThrough();
  const output = new PassThrough();
  output.on('error', () => {});
  const setup = sessionFixture();
  const controller = new AbortController();
  const running = runPluginRpcTransport({
    readable, writable: output, session: setup.session, signal: controller.signal,
  });
  controller.abort();
  assert.deepEqual(setup.calls.close, ['transport-cancelled']);
  await assert.rejects(running, { code: 'PLUGIN_TRANSPORT_CANCELLED', status: 499 });
  assert.equal(readable.destroyed, true);
  assert.deepEqual(setup.calls.close, ['transport-cancelled']);
});

test('host cancellation during output finalization cannot return an EOF success', async () => {
  let finalStartedResolve;
  const finalStarted = new Promise((resolve) => { finalStartedResolve = resolve; });
  const writable = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
    final(_callback) { finalStartedResolve(); },
  });
  const setup = sessionFixture();
  const controller = new AbortController();
  const running = runPluginRpcTransport({
    readable: Readable.from([]), writable, session: setup.session, signal: controller.signal,
  });
  await finalStarted;
  controller.abort();
  await assert.rejects(running, { code: 'PLUGIN_TRANSPORT_CANCELLED', status: 499 });
  assert.deepEqual(setup.calls.close, ['transport-cancelled']);
});

test('in-band cancellation overtakes one bounded active request without queuing work', async () => {
  const binding = Object.freeze({
    pluginId: 'org.platen.example', version: '1.0.0', packageHash: 'a'.repeat(64),
    activationId: 'activation_1234567890', operationId: 'operation_1234567890', nonce: 'b'.repeat(64),
  });
  const handle = `pdfh_${'c'.repeat(64)}`;
  const closed = [];
  const session = new PluginRpcSession({
    binding,
    handles: {
      async getMetadata() { await new Promise(() => {}); },
      async readRange() { return Buffer.alloc(1); },
    },
    limits: { maxInFlight: 1, requestTimeoutMs: 1_000 },
    onClose: ({ reason }) => closed.push(reason),
  });
  const common = {
    protocol: 1, nonce: binding.nonce, pluginId: binding.pluginId, version: binding.version,
    packageHash: binding.packageHash, activationId: binding.activationId,
  };
  const request = encodePluginRpcFrame({
    ...common, type: 'request', id: 'request_1', sequence: 1,
    method: 'document.getMetadata', params: { handle },
  });
  const cancel = encodePluginRpcFrame({
    ...common, type: 'cancel', id: 'cancel_1', sequence: 2, targetId: 'request_1',
  });
  const output = captureWritable();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const result = await runPluginRpcTransport({
      readable: Readable.from([Buffer.concat([request, cancel])]),
      writable: output.writable,
      session,
      signal: controller.signal,
      maxConcurrentRequests: 1,
    });
    assert.equal(result.frameCount, 2);
  } finally {
    clearTimeout(timeout);
  }
  const responses = output.chunks.map((frame) => decodePluginRpcFrame(frame));
  assert.equal(responses.length, 2);
  assert.equal(responses.find(({ id }) => id === 'cancel_1').value.acknowledged, true);
  assert.equal(responses.find(({ id }) => id === 'request_1').error.code, 'PLUGIN_REQUEST_CANCELLED');
  assert.deepEqual(closed, ['transport-eof']);
});

test('transport runs only the configured request count and serializes backpressured responses', async () => {
  const binding = Object.freeze({
    pluginId: 'org.platen.example', version: '1.0.0', packageHash: 'a'.repeat(64),
    activationId: 'activation_1234567890', operationId: 'operation_1234567890', nonce: 'b'.repeat(64),
  });
  const handle = `pdfh_${'c'.repeat(64)}`;
  const releases = [];
  let active = 0;
  let peakActive = 0;
  const session = new PluginRpcSession({
    binding,
    handles: {
      getMetadata() {
        active += 1;
        peakActive = Math.max(peakActive, active);
        const call = releases.length + 1;
        return new Promise((resolve) => releases.push(() => {
          active -= 1;
          resolve({ call });
        }));
      },
      async readRange() { return Buffer.alloc(1); },
    },
    limits: { maxInFlight: 2 },
  });
  const common = {
    protocol: 1, nonce: binding.nonce, pluginId: binding.pluginId, version: binding.version,
    packageHash: binding.packageHash, activationId: binding.activationId, type: 'request',
    method: 'document.getMetadata', params: { handle },
  };
  const frames = [1, 2].map((sequence) => encodePluginRpcFrame({
    ...common, id: `request_${sequence}`, sequence,
  }));
  const chunks = [];
  let underlyingWriteActive = false;
  let overlappingWrite = false;
  const writable = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      if (underlyingWriteActive) overlappingWrite = true;
      underlyingWriteActive = true;
      chunks.push(Buffer.from(chunk));
      setImmediate(() => { underlyingWriteActive = false; callback(); });
    },
  });
  const running = runPluginRpcTransport({
    readable: Readable.from([Buffer.concat(frames)]), writable, session, maxConcurrentRequests: 2,
  });
  await waitFor(() => releases.length === 2);
  releases[1]();
  releases[0]();
  const result = await running;
  assert.equal(result.frameCount, 2);
  assert.equal(peakActive, 2);
  assert.equal(overlappingWrite, false);
  assert.deepEqual(new Set(chunks.map((frame) => decodePluginRpcFrame(frame).id)), new Set(['request_1', 'request_2']));
});

test('transport saturation fails closed instead of creating a pending request queue', async () => {
  const binding = Object.freeze({
    pluginId: 'org.platen.example', version: '1.0.0', packageHash: 'a'.repeat(64),
    activationId: 'activation_1234567890', operationId: 'operation_1234567890', nonce: 'b'.repeat(64),
  });
  const handle = `pdfh_${'c'.repeat(64)}`;
  let started = 0;
  const closed = [];
  const session = new PluginRpcSession({
    binding,
    handles: {
      async getMetadata() { started += 1; await new Promise(() => {}); },
      async readRange() { return Buffer.alloc(1); },
    },
    limits: { maxInFlight: 2 },
    onClose: ({ reason }) => closed.push(reason),
  });
  const common = {
    protocol: 1, nonce: binding.nonce, pluginId: binding.pluginId, version: binding.version,
    packageHash: binding.packageHash, activationId: binding.activationId, type: 'request',
    method: 'document.getMetadata', params: { handle },
  };
  const frames = [1, 2].map((sequence) => encodePluginRpcFrame({
    ...common, id: `request_${sequence}`, sequence,
  }));
  const output = captureWritable();
  output.writable.on('error', () => {});
  await assert.rejects(runPluginRpcTransport({
    readable: Readable.from([Buffer.concat(frames)]),
    writable: output.writable,
    session,
    maxConcurrentRequests: 1,
  }), { code: 'PLUGIN_TRANSPORT_INFLIGHT_LIMIT', status: 429 });
  assert.equal(started, 1);
  assert.deepEqual(closed, ['transport-failed']);
});

test('transport setup failures close authority before returning to the caller', async () => {
  const invalidLimits = sessionFixture();
  await assert.rejects(runPluginRpcTransport({
    readable: Readable.from([]),
    writable: captureWritable().writable,
    session: invalidLimits.session,
    limits: { maxFrameBytes: 0 },
  }), /Plugin frame stream limits must contain supported positive integers/);
  assert.deepEqual(invalidLimits.calls.close, ['transport-setup-failed']);

  const unsafeOutput = sessionFixture();
  await assert.rejects(runPluginRpcTransport({
    readable: Readable.from([]),
    writable: { write() { return false; }, end() {} },
    session: unsafeOutput.session,
  }), /destroyable evented writable stream/);
  assert.deepEqual(unsafeOutput.calls.close, ['transport-setup-failed']);

  const binding = Object.freeze({
    pluginId: 'org.platen.example', version: '1.0.0', packageHash: 'a'.repeat(64),
    activationId: 'activation_1234567890', operationId: 'operation_1234567890', nonce: 'b'.repeat(64),
  });
  const closeReasons = [];
  const boundedSession = new PluginRpcSession({
    binding,
    handles: { async getMetadata() { return {}; }, async readRange() { return Buffer.alloc(1); } },
    limits: { maxInFlight: 1 },
    onClose: ({ reason }) => closeReasons.push(reason),
  });
  await assert.rejects(runPluginRpcTransport({
    readable: Readable.from([]),
    writable: captureWritable().writable,
    session: boundedSession,
    maxConcurrentRequests: 2,
  }), /cannot exceed the bound RPC session limit/);
  assert.deepEqual(closeReasons, ['transport-setup-failed']);
});

test('transport setup reports an aggregate failure when authority cannot be closed', async () => {
  let closeAttempts = 0;
  const session = {
    async processFrame() { return encodePluginRpcFrame({ ok: true }); },
    close() { closeAttempts += 1; throw new Error('authority cleanup failed'); },
  };
  await assert.rejects(runPluginRpcTransport({
    readable: Readable.from([]),
    writable: captureWritable().writable,
    session,
    maxConcurrentRequests: 0,
  }), { code: 'PLUGIN_TRANSPORT_SETUP_CLEANUP_FAILED', status: 500 });
  assert.equal(closeAttempts, 2);
});

test('fallible stream destruction cannot prevent immediate authority closure', async () => {
  const frame = encodePluginRpcFrame({ request: 1 });
  const output = captureWritable();
  const order = [];
  output.writable.destroy = () => {
    order.push('destroy-output');
    throw new Error('output destroy failed');
  };
  const session = {
    async processFrame() { throw new Error('broker failed'); },
    close() { order.push('close-authority'); return true; },
  };
  await assert.rejects(runPluginRpcTransport({
    readable: Readable.from([frame]), writable: output.writable, session,
  }), { code: 'PLUGIN_TRANSPORT_CLEANUP_FAILED', status: 500 });
  assert.deepEqual(order.slice(0, 2), ['close-authority', 'destroy-output']);
});

test('an immediately rejected broker frame terminates transport before the next frame starts', async () => {
  const first = encodePluginRpcFrame({ request: 1 });
  const second = encodePluginRpcFrame({ request: 2 });
  const readable = Readable.from([Buffer.concat([first, second])]);
  const output = captureWritable();
  output.writable.on('error', () => {});
  const calls = { count: 0, close: [] };
  const session = {
    async processFrame() { calls.count += 1; throw new Error('broker denied frame'); },
    close(reason) { calls.close.push(reason); return true; },
  };
  await assert.rejects(
    runPluginRpcTransport({ readable, writable: output.writable, session }),
    /broker denied frame/,
  );
  assert.equal(calls.count, 1);
  assert.deepEqual(calls.close, ['transport-failed']);
});

test('transport sanitizes a non-Error broker rejection and still closes authority', async () => {
  const frame = encodePluginRpcFrame({ request: 1 });
  const output = captureWritable();
  output.writable.on('error', () => {});
  const close = [];
  const session = {
    async processFrame() { throw '/private/secret.pdf'; },
    close(reason) { close.push(reason); return true; },
  };
  await assert.rejects(runPluginRpcTransport({
    readable: Readable.from([frame]), writable: output.writable, session,
  }), {
    code: 'PLUGIN_TRANSPORT_FAILED',
    message: 'The private plugin transport failed.',
    status: 500,
  });
  assert.deepEqual(close, ['transport-failed']);
});
