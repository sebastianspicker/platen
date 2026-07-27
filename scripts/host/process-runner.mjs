import { spawn as nodeSpawn } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { createBoundedProcessLimiter } from './bounded-process-limiter.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
const KILL_REAP_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDIN_BYTES = 64 * 1024 * 1024;

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

function validateCommand(executable, args, cwd) {
  if (typeof executable !== 'string' || !isAbsolute(executable) || executable.includes('\0')) {
    throw new TypeError('executable must be an absolute path without NUL bytes');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TypeError('args must contain only strings without NUL bytes');
  }
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0'))) {
    throw new TypeError('cwd must be an absolute path without NUL bytes');
  }
}

function validateEnvironment(environment, cwd) {
  if (environment === undefined) return Object.freeze({});
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || Object.getPrototypeOf(environment) !== Object.prototype) {
    throw new TypeError('environment must be a plain object');
  }
  if (!cwd) throw new TypeError('environment overrides require an absolute cwd');
  const pathKeys = new Set(['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR']);
  const allowedKeys = new Set([...pathKeys, 'SAL_USE_VCLPLUGIN']);
  const checked = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!allowedKeys.has(key) || typeof value !== 'string' || !value || value.includes('\0')) {
      throw new TypeError('environment contains an unsupported key or value');
    }
    if (pathKeys.has(key)) {
      if (!isAbsolute(value)) throw new TypeError(`${key} must be an absolute path`);
      const pathFromCwd = relative(cwd, value);
      if (pathFromCwd === '..' || pathFromCwd.startsWith('../')) {
        throw new TypeError(`${key} must remain inside cwd`);
      }
    } else if (value !== 'svp') {
      throw new TypeError('SAL_USE_VCLPLUGIN must use the headless svp backend');
    }
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

function validateProcessInvocation({
  executable, args, cwd, stdin, signal, timeoutMs,
  maxStdinBytes, maxStdoutBytes, maxStderrBytes, environment, spawnImpl,
}) {
  validateCommand(executable, args, cwd);
  positiveInteger(maxStdinBytes, 'maxStdinBytes');
  if (maxStdinBytes > MAX_STDIN_BYTES) {
    throw new TypeError(`maxStdinBytes must not exceed ${MAX_STDIN_BYTES}`);
  }
  if (stdin !== undefined && (!Buffer.isBuffer(stdin) || stdin.length > maxStdinBytes)) {
    throw new TypeError(`stdin must be a Buffer no larger than ${maxStdinBytes} bytes`);
  }
  const checkedEnvironment = validateEnvironment(environment, cwd);
  positiveInteger(timeoutMs, 'timeoutMs');
  positiveInteger(maxStdoutBytes, 'maxStdoutBytes');
  positiveInteger(maxStderrBytes, 'maxStderrBytes');
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal');
  }
  return {
    executable, args, cwd, stdin, signal, timeoutMs, maxStdinBytes,
    maxStdoutBytes, maxStderrBytes, checkedEnvironment, spawnImpl,
  };
}

function executeProcess({
  executable, args, cwd, stdinCopy, signal, timeoutMs,
  maxStdoutBytes, maxStderrBytes, checkedEnvironment, spawnImpl,
}) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let child;
    let terminalError = null;
    let reapTimer = null;

    const spawnOptions = {
      cwd,
      env: { LANG: 'C', LC_ALL: 'C', ...checkedEnvironment },
      shell: false,
      stdio: [stdinCopy === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    };

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

    try {
      child = spawnImpl(executable, [...args], spawnOptions);
    } catch (error) {
      finish(reject, new EngineProcessError('Engine process could not be started', {
        code: 'ENGINE_SPAWN_FAILED', executable, args, cause: error,
      }));
      return;
    }

    if (stdinCopy !== null) {
      if (!child.stdin || typeof child.stdin.end !== 'function') {
        terminate(new EngineProcessError('Engine process does not expose a writable stdin pipe', {
          code: 'ENGINE_STDIN_FAILED', executable, args,
        }));
      } else {
        child.stdin.once('error', (error) => terminate(new EngineProcessError('Engine stdin write failed', {
          code: 'ENGINE_STDIN_FAILED', executable, args, cause: error,
        })));
        child.stdin.end(stdinCopy);
      }
    }

    child.stdout?.on('data', (chunk) => {
      if (terminalError) return;
      const result = appendBounded(stdoutChunks, chunk, stdoutBytes, maxStdoutBytes);
      stdoutBytes = result.totalBytes;
      if (result.exceeded) terminate(new EngineOutputLimitError(executable, args, 'stdout', maxStdoutBytes));
    });
    child.stderr?.on('data', (chunk) => {
      if (terminalError) return;
      const result = appendBounded(stderrChunks, chunk, stderrBytes, maxStderrBytes);
      stderrBytes = result.totalBytes;
      if (result.exceeded) terminate(new EngineOutputLimitError(executable, args, 'stderr', maxStderrBytes));
    });
    child.once('error', (error) => {
      if (terminalError) return;
      finish(reject, new EngineProcessError('Engine process failed to start', {
        code: 'ENGINE_SPAWN_FAILED', executable, args, cause: error,
      }));
    });
    child.once('close', (exitCode, closeSignal) => {
      if (terminalError) {
        finish(reject, terminalError);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (exitCode === 0) {
        finish(resolve, Object.freeze({ stdout, stderr, exitCode, signal: closeSignal }));
        return;
      }
      finish(reject, new EngineProcessError(`Engine process exited with code ${exitCode}`, {
        executable, args, exitCode, signal: closeSignal, stdout, stderr,
      }));
    });
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
