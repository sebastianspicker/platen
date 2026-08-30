import { spawn as nodeSpawn } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { createBoundedProcessLimiter } from './bounded-process-limiter.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
const KILL_REAP_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDIN_BYTES = 64 * 1024 * 1024;
const PATH_ENVIRONMENT_KEYS = new Set(['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR']);
const ALLOWED_ENVIRONMENT_KEYS = new Set([...PATH_ENVIRONMENT_KEYS, 'SAL_USE_VCLPLUGIN']);

export class EngineProcessError extends Error {
  constructor(message, {
    code = 'ENGINE_PROCESS_FAILED',
    executable,
    args = [],
    exitCode = null,
    signal = null,
    stdout = '',
    stderr = '',
    cause,
  } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.executable = executable;
    this.args = [...args];
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export class EngineTimeoutError extends EngineProcessError {
  constructor(executable, args, timeoutMs) {
    super(`Engine process exceeded ${timeoutMs} ms`, {
      code: 'ENGINE_TIMEOUT', executable, args,
    });
    this.timeoutMs = timeoutMs;
  }
}

export class EngineCancelledError extends EngineProcessError {
  constructor(executable, args, cause) {
    super('Engine process was cancelled', {
      code: 'ENGINE_CANCELLED', executable, args, cause,
    });
  }
}

export class EngineOutputLimitError extends EngineProcessError {
  constructor(executable, args, stream, limitBytes) {
    super(`Engine ${stream} exceeded ${limitBytes} bytes`, {
      code: 'ENGINE_OUTPUT_LIMIT', executable, args,
    });
    this.stream = stream;
    this.limitBytes = limitBytes;
  }
}

export class EngineQueueFullError extends EngineProcessError {
  constructor(executable, args, maximumQueued) {
    super(`Engine queue already contains ${maximumQueued} waiting jobs`, {
      code: 'ENGINE_QUEUE_FULL', executable, args,
    });
    this.maximumQueued = maximumQueued;
  }
}

export class EngineHostUnhealthyError extends EngineProcessError {
  constructor() {
    super('Every native engine slot is quarantined; restart the local host', {
      code: 'ENGINE_HOST_UNHEALTHY',
    });
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function validateAbsolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
}

function validateCommand(executable, args, cwd) {
  validateAbsolutePath(executable, 'executable');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TypeError('args must contain only strings without NUL bytes');
  }
  if (cwd !== undefined) {
    validateAbsolutePath(cwd, 'cwd');
  }
}

function validateEnvironmentValue(key, value, cwd) {
  if (!ALLOWED_ENVIRONMENT_KEYS.has(key) || typeof value !== 'string' || !value || value.includes('\0')) {
    throw new TypeError('environment contains an unsupported key or value');
  }
  if (PATH_ENVIRONMENT_KEYS.has(key)) {
    if (!isAbsolute(value)) throw new TypeError(`${key} must be an absolute path`);
    const pathFromCwd = relative(cwd, value);
    if (pathFromCwd === '..' || pathFromCwd.startsWith('../')) {
      throw new TypeError(`${key} must remain inside cwd`);
    }
    return;
  }
  if (value !== 'svp') {
    throw new TypeError('SAL_USE_VCLPLUGIN must use the headless svp backend');
  }
}

function validateEnvironment(environment, cwd) {
  if (environment === undefined) return Object.freeze({});
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || Object.getPrototypeOf(environment) !== Object.prototype) {
    throw new TypeError('environment must be a plain object');
  }
  if (!cwd) throw new TypeError('environment overrides require an absolute cwd');
  const checked = {};
  for (const [key, value] of Object.entries(environment)) {
    validateEnvironmentValue(key, value, cwd);
    checked[key] = value;
  }
  return Object.freeze(checked);
}

function appendBounded(chunks, chunk, totalBytes, limitBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const nextTotal = totalBytes + buffer.length;
  if (nextTotal > limitBytes) return { totalBytes: nextTotal, exceeded: true };
  chunks.push(buffer);
  return { totalBytes: nextTotal, exceeded: false };
}

function validateStdin(stdin, maxStdinBytes) {
  positiveInteger(maxStdinBytes, 'maxStdinBytes');
  if (maxStdinBytes > MAX_STDIN_BYTES) {
    throw new TypeError(`maxStdinBytes must not exceed ${MAX_STDIN_BYTES}`);
  }
  if (stdin !== undefined && (!Buffer.isBuffer(stdin) || stdin.length > maxStdinBytes)) {
    throw new TypeError(`stdin must be a Buffer no larger than ${maxStdinBytes} bytes`);
  }
}

function validateOutputConfiguration({ timeoutMs, maxStdoutBytes, maxStderrBytes, stdoutEncoding }) {
  positiveInteger(timeoutMs, 'timeoutMs');
  positiveInteger(maxStdoutBytes, 'maxStdoutBytes');
  positiveInteger(maxStderrBytes, 'maxStderrBytes');
  if (stdoutEncoding !== 'utf8' && stdoutEncoding !== 'buffer') {
    throw new TypeError("stdoutEncoding must be either 'utf8' or 'buffer'");
  }
}

function validateAbortSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal');
  }
}

function validateProcessInvocation({
  executable, args, cwd, stdin, signal, timeoutMs,
  maxStdinBytes, maxStdoutBytes, maxStderrBytes, stdoutEncoding, environment, spawnImpl,
}) {
  validateCommand(executable, args, cwd);
  validateStdin(stdin, maxStdinBytes);
  const checkedEnvironment = validateEnvironment(environment, cwd);
  validateOutputConfiguration({ timeoutMs, maxStdoutBytes, maxStderrBytes, stdoutEncoding });
  validateAbortSignal(signal);
  return {
    executable, args, cwd, stdin, signal, timeoutMs, maxStdinBytes,
    maxStdoutBytes, maxStderrBytes, stdoutEncoding, checkedEnvironment, spawnImpl,
  };
}

function createOutputCollector(limitBytes) {
  const chunks = [];
  let totalBytes = 0;
  return {
    append(chunk) {
      const result = appendBounded(chunks, chunk, totalBytes, limitBytes);
      totalBytes = result.totalBytes;
      return result.exceeded;
    },
    buffer() {
      return Buffer.concat(chunks);
    },
  };
}

function createSpawnOptions({ cwd, stdinCopy, checkedEnvironment }) {
  return {
    cwd,
    env: { LANG: 'C', LC_ALL: 'C', ...checkedEnvironment },
    shell: false,
    stdio: [stdinCopy === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };
}

function createProcessLifecycle({ executable, args, stdinCopy, signal, timeoutMs, resolve, reject }) {
  let settled = false;
  let child;
  let terminalError = null;
  let reapTimer = null;
  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(reapTimer);
    signal?.removeEventListener('abort', onAbort);
    stdinCopy?.fill(0);
  };
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback(value);
  };
  const terminate = (error) => {
    if (settled || terminalError) return;
    terminalError = error;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    try { child?.kill('SIGKILL'); } catch { /* rejection below remains authoritative */ }
    reapTimer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* bounded fallback below remains authoritative */ }
      finish(reject, new EngineProcessError('Engine process did not report exit after forced termination', {
        code: 'ENGINE_REAP_TIMEOUT', executable, args, cause: terminalError,
      }));
    }, KILL_REAP_TIMEOUT_MS);
  };
  const onAbort = () => terminate(new EngineCancelledError(executable, args, signal.reason));
  const timer = setTimeout(
    () => terminate(new EngineTimeoutError(executable, args, timeoutMs)),
    timeoutMs,
  );
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    assignChild(nextChild) {
      child = nextChild;
    },
    finish,
    reject,
    resolve,
    terminate,
    terminalError() {
      return terminalError;
    },
  };
}

function writeStdin(child, stdinCopy, executable, args, terminate) {
  if (stdinCopy === null) return;
  if (!child.stdin || typeof child.stdin.end !== 'function') {
    terminate(new EngineProcessError('Engine process does not expose a writable stdin pipe', {
      code: 'ENGINE_STDIN_FAILED', executable, args,
    }));
    return;
  }
  child.stdin.once('error', (error) => terminate(new EngineProcessError('Engine stdin write failed', {
    code: 'ENGINE_STDIN_FAILED', executable, args, cause: error,
  })));
  child.stdin.end(stdinCopy);
}

function attachOutput(child, stdout, stderr, executable, args, maxStdoutBytes, maxStderrBytes, lifecycle) {
  child.stdout?.on('data', (chunk) => {
    if (lifecycle.terminalError()) return;
    if (stdout.append(chunk)) {
      lifecycle.terminate(new EngineOutputLimitError(executable, args, 'stdout', maxStdoutBytes));
    }
  });
  child.stderr?.on('data', (chunk) => {
    if (lifecycle.terminalError()) return;
    if (stderr.append(chunk)) {
      lifecycle.terminate(new EngineOutputLimitError(executable, args, 'stderr', maxStderrBytes));
    }
  });
}

function completeProcess({ exitCode, closeSignal, executable, args, stdout, stderr, stdoutEncoding, lifecycle }) {
  const terminalError = lifecycle.terminalError();
  if (terminalError) {
    lifecycle.finish(lifecycle.reject, terminalError);
    return;
  }
  const capturedStdout = stdout.buffer();
  const capturedStderr = stderr.buffer().toString('utf8');
  if (exitCode === 0) {
    const resultStdout = stdoutEncoding === 'buffer' ? capturedStdout : capturedStdout.toString('utf8');
    lifecycle.finish(lifecycle.resolve, Object.freeze({ stdout: resultStdout, stderr: capturedStderr, exitCode, signal: closeSignal }));
    return;
  }
  const errorStdout = stdoutEncoding === 'buffer' ? capturedStdout : capturedStdout.toString('utf8');
  lifecycle.finish(lifecycle.reject, new EngineProcessError(`Engine process exited with code ${exitCode}`, {
    executable, args, exitCode, signal: closeSignal, stdout: errorStdout, stderr: capturedStderr,
  }));
}

function executeProcess({
  executable, args, cwd, stdinCopy, signal, timeoutMs,
  maxStdoutBytes, maxStderrBytes, stdoutEncoding, checkedEnvironment, spawnImpl,
}) {
  return new Promise((resolve, reject) => {
    const stdout = createOutputCollector(maxStdoutBytes);
    const stderr = createOutputCollector(maxStderrBytes);
    const lifecycle = createProcessLifecycle({ executable, args, stdinCopy, signal, timeoutMs, resolve, reject });

    let child;
    try {
      child = spawnImpl(executable, [...args], createSpawnOptions({ cwd, stdinCopy, checkedEnvironment }));
    } catch (error) {
      lifecycle.finish(reject, new EngineProcessError('Engine process could not be started', {
        code: 'ENGINE_SPAWN_FAILED', executable, args, cause: error,
      }));
      return;
    }
    lifecycle.assignChild(child);
    writeStdin(child, stdinCopy, executable, args, lifecycle.terminate);
    attachOutput(child, stdout, stderr, executable, args, maxStdoutBytes, maxStderrBytes, lifecycle);
    child.once('error', (error) => {
      if (lifecycle.terminalError()) return;
      lifecycle.finish(reject, new EngineProcessError('Engine process failed to start', {
        code: 'ENGINE_SPAWN_FAILED', executable, args, cause: error,
      }));
    });
    child.once('close', (exitCode, closeSignal) => completeProcess({
      exitCode, closeSignal, executable, args, stdout, stderr, stdoutEncoding, lifecycle,
    }));
  });
}

export function runProcess({
  executable,
  args = [],
  cwd,
  stdin,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxStdinBytes = DEFAULT_MAX_STDIN_BYTES,
  maxStdoutBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
  maxStderrBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
  stdoutEncoding = 'utf8',
  environment,
  spawnImpl = nodeSpawn,
} = {}) {
  const invocation = validateProcessInvocation({
    executable,
    args,
    cwd,
    stdin,
    signal,
    timeoutMs,
    maxStdinBytes,
    maxStdoutBytes,
    maxStderrBytes,
    stdoutEncoding,
    environment,
    spawnImpl,
  });
  if (signal?.aborted) {
    return Promise.reject(new EngineCancelledError(executable, args, signal.reason));
  }
  return executeProcess({
    ...invocation,
    stdinCopy: stdin === undefined ? null : Buffer.from(stdin),
  });
}

export function createProcessLimiter({ runner = runProcess, concurrency = 4, maximumQueued = 24 } = {}) {
  return createBoundedProcessLimiter({
    runner,
    concurrency,
    maximumQueued,
    cancelledError: (executable, args, cause) => new EngineCancelledError(executable, args, cause),
    queueFullError: (executable, args, maximum) => new EngineQueueFullError(executable, args, maximum),
    hostUnhealthyError: () => new EngineHostUnhealthyError(),
  });
}
