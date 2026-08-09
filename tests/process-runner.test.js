import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { EngineProcessError, runProcess } from '../scripts/host/process-runner.mjs';

function binarySpawn(onSpawn) {
  return (_executable, _args, _options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => onSpawn(child));
    return child;
  };
}

test('runner keeps utf8 stdout as the default capture mode', async () => {
  const result = await runProcess({
    executable: '/tools/pdfinfo',
    spawnImpl: binarySpawn((child) => {
      child.stdout.end(Buffer.from([0x66, 0x6f, 0x6f]));
      child.stderr.end();
      child.emit('close', 0, null);
    }),
  });
  assert.equal(result.stdout, 'foo');
  assert.equal(typeof result.stdout, 'string');
});

test('runner captures bounded binary stdout without UTF-8 conversion', async () => {
  const payload = Buffer.from([0x00, 0xff, 0x80, 0x41]);
  const result = await runProcess({
    executable: '/tools/cups-filter',
    stdoutEncoding: 'buffer',
    maxStdoutBytes: payload.length,
    spawnImpl: binarySpawn((child) => {
      child.stdout.write(payload.subarray(0, 2));
      child.stdout.end(payload.subarray(2));
      child.stderr.end();
      child.emit('close', 0, null);
    }),
  });
  assert.ok(Buffer.isBuffer(result.stdout));
  assert.deepEqual(result.stdout, payload);
  assert.equal(result.stderr, '');
});

test('runner rejects invalid stdout capture modes before spawning', () => {
  let spawned = false;
  assert.throws(() => runProcess({
    executable: '/tools/cups-filter',
    stdoutEncoding: 'hex',
    spawnImpl() { spawned = true; },
  }), /stdoutEncoding must be either 'utf8' or 'buffer'/);
  assert.equal(spawned, false);
});

test('runner preserves binary stdout on a nonzero process error', async () => {
  const payload = Buffer.from([0xff, 0x00, 0x7f]);
  await assert.rejects(
    runProcess({
      executable: '/tools/cups-filter',
      stdoutEncoding: 'buffer',
      spawnImpl: binarySpawn((child) => {
        child.stdout.end(payload);
        child.stderr.end('filter failed');
        child.emit('close', 1, null);
      }),
    }),
    (error) => error instanceof EngineProcessError
      && error.code === 'ENGINE_PROCESS_FAILED'
      && Buffer.isBuffer(error.stdout)
      && error.stdout.equals(payload)
      && error.stderr === 'filter failed',
  );
});
