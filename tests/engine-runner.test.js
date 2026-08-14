import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  createProcessLimiter,
  EngineCancelledError,
  EngineOutputLimitError,
  EngineProcessError,
  EngineTimeoutError,
  runProcess,
} from '../scripts/host/process-runner.mjs';

function fakeSpawn(onSpawn) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killedWith = null;
    child.kill = (signal) => {
      child.killedWith = signal;
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    queueMicrotask(() => onSpawn({ child, executable, args, options }));
    return child;
  };
}

test('runner uses an argv-only spawn with a minimal environment', async () => {
  let invocation;
  const result = await runProcess({
    executable: '/tools/pdfinfo',
    args: ['/tmp/file name.pdf'],
    spawnImpl: fakeSpawn((current) => {
      invocation = current;
      current.child.stdout.end('Pages: 1\n');
      current.child.stderr.end();
      current.child.emit('close', 0, null);
    }),
  });
  assert.deepEqual(result, { stdout: 'Pages: 1\n', stderr: '', exitCode: 0, signal: null });
  assert.equal(invocation.executable, '/tools/pdfinfo');
  assert.deepEqual(invocation.args, ['/tmp/file name.pdf']);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.env, { LANG: 'C', LC_ALL: 'C' });
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('runner sends one bounded private Buffer through stdin without adding it to argv', async () => {
  const secret = Buffer.from('{"password":"private-value"}');
  let invocation;
  let received = Buffer.alloc(0);
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
    child.stdin.once('end', () => {
      child.stdout.end('{}');
      child.stderr.end();
      child.emit('close', 0, null);
    });
    invocation = { executable, args, options };
    return child;
  };
  const result = await runProcess({
    executable: '/tools/private-helper',
    args: ['--protect-stdin'],
    stdin: secret,
    spawnImpl,
  });
  assert.equal(result.stdout, '{}');
  assert.deepEqual(invocation.args, ['--protect-stdin']);
  assert.deepEqual(invocation.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(received, secret);
  assert.throws(() => runProcess({
    executable: '/tools/private-helper', stdin: 'private-value',
  }), /stdin must be a Buffer/);
  assert.throws(() => runProcess({
    executable: '/tools/private-helper', stdin: Buffer.alloc(1024 * 1024 + 1),
  }), /no larger than 1048576 bytes/);
  assert.throws(() => runProcess({
    executable: '/tools/private-helper', maxStdinBytes: 64 * 1024 * 1024 + 1,
  }), /must not exceed 67108864/);
});

test('runner permits only pinned workspace-local environment overrides', async () => {
  let invocation;
  await runProcess({
    executable: '/tools/soffice',
    cwd: '/jobs/private',
    environment: { HOME: '/jobs/private', TMPDIR: '/jobs/private/tmp', SAL_USE_VCLPLUGIN: 'svp' },
    spawnImpl: fakeSpawn((current) => {
      invocation = current;
      current.child.stdout.end();
      current.child.stderr.end();
      current.child.emit('close', 0, null);
    }),
  });
  assert.deepEqual(invocation.options.env, {
    LANG: 'C', LC_ALL: 'C', HOME: '/jobs/private', TMPDIR: '/jobs/private/tmp', SAL_USE_VCLPLUGIN: 'svp',
  });
  assert.throws(() => runProcess({
    executable: '/tools/soffice', cwd: '/jobs/private', environment: { HOME: '/Users/private' },
  }), /inside cwd/);
  assert.throws(() => runProcess({
    executable: '/tools/soffice', cwd: '/jobs/private', environment: { PATH: '/tools' },
  }), /unsupported/);
});

test('runner returns typed nonzero-exit errors with bounded stderr', async () => {
  await assert.rejects(
    runProcess({
      executable: '/tools/pdfinfo',
      spawnImpl: fakeSpawn(({ child }) => {
        child.stderr.end('invalid PDF');
        child.stdout.end('bounded diagnostic');
        child.emit('close', 2, null);
      }),
    }),
    (error) => error instanceof EngineProcessError
      && error.code === 'ENGINE_PROCESS_FAILED'
      && error.exitCode === 2
      && error.stdout === 'bounded diagnostic'
      && error.stderr === 'invalid PDF',
  );
});

test('runner kills output-flooding children and rejects with a typed limit error', async () => {
  let child;
  await assert.rejects(
    runProcess({
      executable: '/tools/pdftotext',
      maxStdoutBytes: 4,
      spawnImpl: fakeSpawn((invocation) => {
        child = invocation.child;
        child.stdout.write('12345');
      }),
    }),
    (error) => error instanceof EngineOutputLimitError
      && error.code === 'ENGINE_OUTPUT_LIMIT'
      && error.stream === 'stdout',
  );
  assert.equal(child.killedWith, 'SIGKILL');
});

test('runner supports timeout and AbortSignal cancellation', async () => {
  let timedOutChild;
  await assert.rejects(
    runProcess({
      executable: '/tools/pdfinfo',
      timeoutMs: 5,
      spawnImpl: fakeSpawn((invocation) => { timedOutChild = invocation.child; }),
    }),
    (error) => error instanceof EngineTimeoutError && error.code === 'ENGINE_TIMEOUT',
  );
  assert.equal(timedOutChild.killedWith, 'SIGKILL');

  const controller = new AbortController();
  let cancelledChild;
  const promise = runProcess({
    executable: '/tools/pdfinfo',
    signal: controller.signal,
    spawnImpl: fakeSpawn((invocation) => {
      cancelledChild = invocation.child;
      controller.abort('user request');
    }),
  });
  await assert.rejects(promise, (error) => error instanceof EngineCancelledError && error.code === 'ENGINE_CANCELLED');
  assert.equal(cancelledChild.killedWith, 'SIGKILL');
});

test('runner rejects relative executables and NUL-bearing argv before spawn', () => {
  assert.throws(() => runProcess({ executable: 'pdfinfo' }), /absolute path/);
  assert.throws(() => runProcess({ executable: '/tools/pdfinfo', args: ['bad\0arg'] }), /NUL/);
});

test('shared process limiter caps active and queued engine jobs', async () => {
  const releases = [];
  let active = 0;
  let maximumActive = 0;
  const limited = createProcessLimiter({
    concurrency: 1,
    maximumQueued: 1,
    runner: async ({ id }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return id;
    },
  });

  const first = limited({ id: 'first', executable: '/tools/pdfinfo', args: [] });
  const second = limited({ id: 'second', executable: '/tools/pdfinfo', args: [] });
  await assert.rejects(
    limited({ id: 'third', executable: '/tools/pdfinfo', args: [] }),
    { code: 'ENGINE_QUEUE_FULL', maximumQueued: 1 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  assert.equal(await first, 'first');
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  assert.equal(await second, 'second');
  assert.equal(maximumActive, 1);
});

test('shared process limiter removes cancelled work before it starts', async () => {
  let release;
  const firstGate = new Promise((resolve) => { release = resolve; });
  const starts = [];
  const limited = createProcessLimiter({
    concurrency: 1,
    maximumQueued: 1,
    runner: async ({ id }) => {
      starts.push(id);
      if (id === 'active') await firstGate;
      return id;
    },
  });
  const active = limited({ id: 'active', executable: '/tools/pdfinfo', args: [] });
  const controller = new AbortController();
  const queued = limited({
    id: 'cancelled', executable: '/tools/pdfinfo', args: [], signal: controller.signal,
  });
  controller.abort('user request');
  await assert.rejects(queued, { code: 'ENGINE_CANCELLED' });
  const replacement = limited({ id: 'replacement', executable: '/tools/pdfinfo', args: [] });
  release();
  assert.equal(await active, 'active');
  assert.equal(await replacement, 'replacement');
  assert.deepEqual(starts, ['active', 'replacement']);
});

test('shared limiter holds a slot until a killed native child reports close', async () => {
  const starts = [];
  const children = new Map();
  let reportTimeoutKill;
  const timeoutKill = new Promise((resolve) => { reportTimeoutKill = resolve; });
  const spawnImpl = (_executable, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      if (args[0] === 'first') reportTimeoutKill(signal);
      return true;
    };
    starts.push(args[0]);
    children.set(args[0], child);
    if (args[0] === 'second') queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  const limited = createProcessLimiter({
    concurrency: 1,
    maximumQueued: 1,
    runner: ({ id }) => runProcess({
      executable: '/tools/pdfinfo',
      args: [id],
      timeoutMs: id === 'first' ? 5 : 1_000,
      spawnImpl,
    }),
  });
  const first = limited({ id: 'first' });
  const second = limited({ id: 'second' });
  assert.equal(await timeoutKill, 'SIGKILL');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['first']);
  children.get('first').emit('close', null, 'SIGKILL');
  await assert.rejects(first, { code: 'ENGINE_TIMEOUT' });
  assert.equal((await second).exitCode, 0);
  assert.deepEqual(starts, ['first', 'second']);
});

test('shared limiter quarantines a slot after an unreaped child', async () => {
  const starts = [];
  const reapError = Object.assign(new Error('unreaped'), { code: 'ENGINE_REAP_TIMEOUT' });
  const limited = createProcessLimiter({
    concurrency: 1,
    maximumQueued: 1,
    runner: async ({ id }) => { starts.push(id); throw reapError; },
  });
  const first = limited({ id: 'first' });
  const stranded = limited({ id: 'stranded' });
  await assert.rejects(first, { code: 'ENGINE_REAP_TIMEOUT' });
  await assert.rejects(stranded, { code: 'ENGINE_HOST_UNHEALTHY' });
  assert.deepEqual(starts, ['first']);
  await assert.rejects(limited({ id: 'rejected' }), { code: 'ENGINE_HOST_UNHEALTHY' });
});

test('a quarantined slot preserves the remaining capacity and propagates host health only when exhausted', async () => {
  const starts = [];
  let releaseHealthy;
  const healthyGate = new Promise((resolve) => { releaseHealthy = resolve; });
  const reapError = Object.assign(new Error('unreaped'), { code: 'ENGINE_REAP_TIMEOUT' });
  const limited = createProcessLimiter({
    concurrency: 2,
    maximumQueued: 1,
    runner: async ({ id }) => {
      starts.push(id);
      if (id === 'quarantined') throw reapError;
      if (id === 'healthy') await healthyGate;
      return id;
    },
  });
  const quarantined = limited({ id: 'quarantined' });
  const healthy = limited({ id: 'healthy' });
  const queued = limited({ id: 'queued' });
  await assert.rejects(quarantined, { code: 'ENGINE_REAP_TIMEOUT' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['quarantined', 'healthy']);
  releaseHealthy();
  assert.equal(await healthy, 'healthy');
  assert.equal(await queued, 'queued');
  assert.deepEqual(starts, ['quarantined', 'healthy', 'queued']);
});
