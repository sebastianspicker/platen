import { spawn as nodeSpawn } from 'node:child_process';
import { dirname } from 'node:path';
import { nativeBoundaryError, waitNativeBoundary } from './plugin-native-deadline.mjs';
import {
  MAX_NATIVE_FRAMES,
  MAX_NATIVE_STDOUT_BYTES,
  NativeFrameInbox,
} from './plugin-native-frame-inbox.mjs';
import {
  nativeProcessGroupExists,
  signalNativeProcessGroup,
  waitForNativeProcessGroupGone,
} from './plugin-native-process-group.mjs';

const MAX_NATIVE_STDERR_BYTES = 8 * 1024;

function processExit(child) {
  let terminal = null;
  let processError = null;
  const promise = new Promise((resolve) => {
    child.once('error', (error) => { processError ??= error; });
    child.once('close', (code, signal) => {
      if (terminal) return;
      terminal = Object.freeze({ code, signal, error: processError });
      resolve(terminal);
    });
  });
  return { promise, current: () => terminal, error: () => processError };
}

function boundedStderr(stream, terminate) {
  if (!stream || typeof stream.on !== 'function' || typeof stream.destroy !== 'function') {
    throw new TypeError('Native supervisor stderr must be a destroyable readable stream.');
  }
  let bytes = 0;
  stream.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_NATIVE_STDERR_BYTES) terminate(nativeBoundaryError(
      'PLUGIN_NATIVE_OUTPUT_LIMIT',
      'The native plugin process exceeded its diagnostic output limit.',
      502,
    ));
  });
  stream.on('error', () => {});
  return () => bytes;
}

async function writeChunk(writable, chunk, { timeoutMs, signal }) {
  const pending = new Promise((resolve, reject) => {
    try {
      writable.write(chunk, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) { reject(error); }
  });
  return waitNativeBoundary(pending, {
    timeoutMs,
    signal,
    code: 'PLUGIN_NATIVE_STDIN_TIMEOUT',
    message: 'The native plugin input pipe did not accept bytes in time.',
  });
}

async function endWritable(writable, chunk, { timeoutMs, signal }) {
  const pending = new Promise((resolve, reject) => {
    try {
      writable.end(chunk, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) { reject(error); }
  });
  return waitNativeBoundary(pending, {
    timeoutMs,
    signal,
    code: 'PLUGIN_NATIVE_STDIN_TIMEOUT',
    message: 'The native plugin input pipe did not close in time.',
  });
}

/** Owns one dedicated supervisor process group and its two-frame stdout stream. */
export class NativeSupervisorProcess {
  #child;
  #exit;
  #inbox;
  #killGroup;
  #probeGroup;
  #closePromise = null;
  #closed = false;
  #terminalError = null;
  #stderrBytes;

  constructor({
    child,
    killGroup = signalNativeProcessGroup,
    probeGroup = nativeProcessGroupExists,
  } = {}) {
    if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1
      || !Array.isArray(child.stdio) || child.stdio.length < 5
      || !child.stdin || !child.stdout || typeof child.kill !== 'function'
      || typeof child.once !== 'function' || typeof killGroup !== 'function'
      || typeof probeGroup !== 'function') {
      throw new TypeError('Native supervisor process is invalid.');
    }
    const rpcReadable = child.stdio[3];
    const rpcWritable = child.stdio[4];
    if (!rpcReadable || typeof rpcReadable[Symbol.asyncIterator] !== 'function'
      || typeof rpcReadable.destroy !== 'function' || !rpcWritable
      || typeof rpcWritable.write !== 'function' || typeof rpcWritable.destroy !== 'function'
      || typeof rpcWritable.end !== 'function' || typeof rpcWritable.once !== 'function'
      || typeof rpcWritable.off !== 'function') {
      throw new TypeError('Native supervisor private RPC pipes are invalid.');
    }
    this.#child = child;
    this.#killGroup = killGroup;
    this.#probeGroup = probeGroup;
    this.#exit = processExit(child);
    this.#inbox = new NativeFrameInbox(child.stdout);
    this.#stderrBytes = boundedStderr(child.stderr, (error) => {
      this.#terminalError ??= error;
      void this.close('native-output-limit').catch(() => {});
    });
  }

  get pid() { return this.#child.pid; }
  get rpcReadable() { return this.#child.stdio[3]; }
  get rpcWritable() { return this.#child.stdio[4]; }
  get stderrBytes() { return this.#stderrBytes(); }

  nextFrame(options) { return this.#inbox.next(options); }
  assertReadyOnly() { this.#inbox.assertReadyOnly(); }
  beginInvocation() { this.#inbox.beginInvocation(); }

  async writePreparation(header, source, options) {
    if (this.#closed || this.#child.stdin.destroyed || this.#child.stdin.writableEnded) {
      throw nativeBoundaryError('PLUGIN_NATIVE_STDIN_CLOSED', 'The native plugin input pipe is closed.', 410);
    }
    await writeChunk(this.#child.stdin, header, options);
    await writeChunk(this.#child.stdin, source, options);
  }

  async writeInvocation(header, control, options) {
    if (this.#closed || this.#child.stdin.destroyed || this.#child.stdin.writableEnded) {
      throw nativeBoundaryError('PLUGIN_NATIVE_STDIN_CLOSED', 'The native plugin input pipe is closed.', 410);
    }
    await writeChunk(this.#child.stdin, header, options);
    await endWritable(this.#child.stdin, control, options);
  }

  async finish({ timeoutMs, signal }) {
    const [exit, stream] = await Promise.all([
      waitNativeBoundary(this.#exit.promise, {
        timeoutMs,
        signal,
        code: 'PLUGIN_NATIVE_EXIT_TIMEOUT',
        message: 'The native plugin process did not exit in time.',
      }),
      this.#inbox.done({ timeoutMs, signal }),
      waitForNativeProcessGroupGone({
        pid: this.pid,
        probeGroup: this.#probeGroup,
        timeoutMs,
        signal,
      }),
    ]);
    if (this.#terminalError) throw this.#terminalError;
    if (exit.error || exit.code !== 0 || exit.signal !== null || stream.frameCount !== MAX_NATIVE_FRAMES) {
      throw nativeBoundaryError('PLUGIN_NATIVE_PROCESS_FAILED', 'The native plugin process did not exit cleanly.', 502, exit.error);
    }
    this.#closed = true;
    return Object.freeze({ ...exit, ...stream, stderrBytes: this.stderrBytes });
  }

  async close(reason = 'native-runtime-close', { graceMs = 250, reapMs = 2_000 } = {}) {
    if (this.#closed) return false;
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#close(reason, { graceMs, reapMs });
    try { return await this.#closePromise; }
    finally { if (!this.#closed) this.#closePromise = null; }
  }

  async #close(_reason, { graceMs, reapMs }) {
    this.#inbox.abort();
    for (const stream of [this.#child.stdin, this.rpcReadable, this.rpcWritable]) {
      if (stream && typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy();
    }
    if (!this.#exit.current()) this.#killGroup(this.pid, 'SIGTERM');
    try {
      await this.#waitForReap(graceMs);
    } catch (graceError) {
      this.#killGroup(this.pid, 'SIGKILL');
      try { await this.#waitForReap(reapMs); }
      catch (reapError) {
        throw nativeBoundaryError(
          'PLUGIN_NATIVE_REAP_TIMEOUT',
          'The native plugin process group could not be reaped.',
          500,
          new AggregateError([graceError, reapError], 'Native process-group reap failed.'),
        );
      }
    }
    const exit = this.#exit.current();
    if (!exit) throw nativeBoundaryError('PLUGIN_NATIVE_REAP_TIMEOUT', 'The native plugin process could not be reaped.', 500);
    this.#closed = true;
    return true;
  }

  async #waitForReap(timeoutMs) {
    await Promise.all([
      waitNativeBoundary(this.#exit.promise, {
        timeoutMs,
        code: 'PLUGIN_NATIVE_REAP_TIMEOUT',
        message: 'The native plugin process could not be reaped.',
      }),
      waitForNativeProcessGroupGone({
        pid: this.pid,
        probeGroup: this.#probeGroup,
        timeoutMs,
      }),
    ]);
  }
}

async function cleanRejectedSpawn(child, killGroup, probeGroup) {
  let exit = null;
  if (typeof child.once === 'function') exit = processExit(child);
  killGroup(child.pid, 'SIGKILL');
  const waits = [waitForNativeProcessGroupGone({
    pid: child.pid,
    probeGroup,
    timeoutMs: 2_000,
  })];
  if (exit) {
    waits.push(waitNativeBoundary(exit.promise, {
      timeoutMs: 2_000,
      code: 'PLUGIN_NATIVE_REAP_TIMEOUT',
      message: 'The rejected native plugin process could not be reaped.',
    }));
  }
  await Promise.all(waits);
}

export async function spawnNativeSupervisor({
  executable,
  spawnImpl = nodeSpawn,
  killGroup = signalNativeProcessGroup,
  probeGroup = nativeProcessGroupExists,
} = {}) {
  if (typeof spawnImpl !== 'function') throw new TypeError('Native supervisor spawn implementation must be callable.');
  if (typeof killGroup !== 'function' || typeof probeGroup !== 'function') {
    throw new TypeError('Native supervisor process-group controls must be callable.');
  }
  let child;
  try {
    child = spawnImpl(executable, [], {
      cwd: dirname(executable),
      env: Object.freeze({}),
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw nativeBoundaryError('PLUGIN_NATIVE_SPAWN_FAILED', 'The native plugin supervisor could not be started.', 503, error);
  }
  if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1) {
    throw nativeBoundaryError('PLUGIN_NATIVE_SPAWN_FAILED', 'The native plugin supervisor could not be started.', 503);
  }
  try { return new NativeSupervisorProcess({ child, killGroup, probeGroup }); }
  catch (error) {
    try { await cleanRejectedSpawn(child, killGroup, probeGroup); }
    catch (cleanupError) {
      throw nativeBoundaryError(
        'PLUGIN_NATIVE_SPAWN_CLEANUP_FAILED',
        'The rejected native plugin supervisor could not be reaped.',
        500,
        new AggregateError([error, cleanupError], 'Native spawn validation and cleanup failed.'),
      );
    }
    throw nativeBoundaryError(
      'PLUGIN_NATIVE_SPAWN_FAILED',
      'The native plugin supervisor could not be started.',
      503,
      error,
    );
  }
}

export const NATIVE_SUPERVISOR_PROCESS_LIMITS = Object.freeze({
  maxFrames: MAX_NATIVE_FRAMES,
  maxStdoutBytes: MAX_NATIVE_STDOUT_BYTES,
  maxStderrBytes: MAX_NATIVE_STDERR_BYTES,
});
