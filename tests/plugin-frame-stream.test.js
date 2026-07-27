import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { HostError } from '../scripts/host/host-error.mjs';
import { PluginFrameParser, PluginFrameWriter } from '../scripts/host/plugin-frame-stream.mjs';

function frame(body) {
  const bytes = Buffer.from(body);
  const result = Buffer.alloc(bytes.length + 4);
  result.writeUInt32BE(bytes.length);
  bytes.copy(result, 4);
  return result;
}

test('parser incrementally emits exact complete frames and remains bounded', async () => {
  const received = [];
  const parser = new PluginFrameParser({ limits: { maxFrameBytes: 32 }, onFrame: async (value) => received.push(value) });
  const first = frame('{"one":1}');
  const second = frame('{"two":2}');
  await parser.push(first.subarray(0, 2));
  assert.equal(parser.bufferedBytes, 2);
  await parser.push(Buffer.concat([first.subarray(2), second.subarray(0, 3)]));
  assert.equal(received.length, 1);
  assert.equal(parser.bufferedBytes, 3);
  await parser.push(second.subarray(3));
  assert.deepEqual(received, [first, second]);
  assert.equal(parser.bufferedBytes, 0);
  assert.equal(parser.maxBufferedBytes, 36);
  assert.equal(parser.finish(), true);
});

test('parser enforces prefix and cumulative limits and detects truncated input', async () => {
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(9);
  const parser = new PluginFrameParser({ limits: { maxFrameBytes: 8, maxCumulativeBytes: 12 }, onFrame: () => {} });
  await assert.rejects(parser.push(oversized), { code: 'PLUGIN_FRAME_TOO_LARGE' });
  assert.equal(parser.abort(), false);

  const limited = new PluginFrameParser({ limits: { maxFrameBytes: 8, maxCumulativeBytes: 5 }, onFrame: () => {} });
  await assert.rejects(limited.push(Buffer.alloc(6)), { code: 'PLUGIN_FRAME_CUMULATIVE_LIMIT' });

  const truncated = new PluginFrameParser({ onFrame: () => {} });
  await truncated.push(frame('x').subarray(0, 4));
  assert.throws(() => truncated.finish(), { code: 'PLUGIN_FRAME_TRUNCATED' });
  assert.equal(truncated.close(), false);
});

test('parser preserves raw malformed payloads for broker-owned UTF-8 and JSON validation', async () => {
  const received = [];
  const parser = new PluginFrameParser({ onFrame: (value) => received.push(value) });
  const invalidUtf8 = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
  await parser.push(invalidUtf8);
  assert.deepEqual(received, [invalidUtf8]);
  parser.finish();
});

test('parser cancellation is idempotent and stops an in-progress callback path', async () => {
  let parser;
  parser = new PluginFrameParser({ onFrame: () => parser.cancel() });
  await assert.rejects(parser.push(frame('x')), { code: 'PLUGIN_FRAME_INPUT_CLOSED' });
  assert.equal(parser.cancel(), false);
  assert.equal(parser.close(), false);
});

test('writer honors backpressure, validates frames, and has idempotent lifecycle methods', async () => {
  class BackpressuredWritable extends EventEmitter {
    writableEnded = false;
    writes = [];
    write(value) { this.writes.push(Buffer.from(value)); queueMicrotask(() => this.emit('drain')); return false; }
    end(callback) { this.writableEnded = true; callback(); }
  }
  const writable = new BackpressuredWritable();
  const writer = new PluginFrameWriter({ writable });
  const value = frame('ok');
  await writer.write(value);
  assert.deepEqual(writable.writes, [value]);
  await assert.rejects(writer.write(Buffer.from([0, 0, 0, 2, 1])), { code: 'PLUGIN_FRAME_TRUNCATED' });
  assert.equal(await writer.close(), true);
  assert.equal(writable.writableEnded, true);
  assert.equal(await writer.close(), false);

  const limitedStream = new PassThrough();
  limitedStream.on('error', () => {});
  const limitedWriter = new PluginFrameWriter({
    writable: limitedStream,
    limits: { maxFrameBytes: 8, maxCumulativeBytes: value.length },
  });
  await limitedWriter.write(value);
  assert.equal(limitedWriter.writtenBytes, value.length);
  await assert.rejects(limitedWriter.write(value), { code: 'PLUGIN_FRAME_CUMULATIVE_LIMIT' });
  assert.equal(limitedWriter.closed, true);

  const cancelStream = new PassThrough();
  cancelStream.on('error', () => {});
  const cancelled = new PluginFrameWriter({ writable: cancelStream });
  assert.equal(cancelled.cancel(new HostError('PLUGIN_CANCELLED', 'cancelled', 499)), true);
  assert.equal(cancelled.abort(), false);
});

test('writer abort interrupts an output stream that is still finalizing', async () => {
  let finalStartedResolve;
  const finalStarted = new Promise((resolve) => { finalStartedResolve = resolve; });
  const writable = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
    final(_callback) { finalStartedResolve(); },
  });
  const writer = new PluginFrameWriter({ writable });
  const closing = writer.close();
  await finalStarted;
  assert.equal(writer.closed, false);
  const cancellation = new HostError('PLUGIN_CANCELLED', 'cancelled', 499);
  assert.equal(writer.abort(cancellation), true);
  await assert.rejects(closing, { code: 'PLUGIN_CANCELLED', status: 499 });
  assert.equal(writer.closed, true);
  assert.equal(writer.abort(), false);
});
