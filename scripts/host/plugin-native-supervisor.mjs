import { HostError } from './host-error.mjs';
import { verifyStagedNativeHelper } from './native-helper-loader.mjs';
import { DarwinPluginCodeIdentityVerifier } from './plugin-native-code-identity.mjs';
import { runPluginRpcTransport } from './plugin-rpc-transport.mjs';
import {
  decodeNativeReadyFrame,
  encodeNativeInvocationPhase,
  encodeNativePreparation,
  NATIVE_PLUGIN_PROTOCOL_LIMITS,
  unframeNativeCompletion,
  validateNativeExecutablePair,
  validateNativeLaunch,
} from './plugin-native-supervisor-contract.mjs';
import { spawnNativeSupervisor } from './plugin-native-supervisor-process.mjs';

const DEFAULT_LIMITS = Object.freeze({
  launchTimeoutMs: 5_000,
  invokeTimeoutMs: 10_000,
  gracefulTerminationMs: 250,
  reapTimeoutMs: 2_000,
});

function fail(code, message, status = 503, cause) {
  throw new HostError(code, message, status, cause === undefined ? {} : { cause });
}

function normalizeLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Native supervisor limits must be an object.');
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > 60_000) {
      throw new TypeError('Native supervisor limits must contain supported bounded positive integers.');
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}

function assertAuthority(value, methods, label) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`${label} does not implement the required authority.`);
  }
}

function validateSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
  if (signal?.aborted) fail('PLUGIN_NATIVE_CANCELLED', 'The native plugin operation was cancelled.', 499, signal.reason);
}

function validateInvokeOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 3
    || !['control', 'rpc', 'signal'].every((field) => Object.hasOwn(value, field))) {
    throw new TypeError('Native worker invocation must contain exact control, rpc, and signal fields.');
  }
  if (!Buffer.isBuffer(value.control) || value.control.length < 1
    || value.control.length > NATIVE_PLUGIN_PROTOCOL_LIMITS.maxFrameBytes) {
    fail('PLUGIN_NATIVE_CONTROL_INVALID', 'The native plugin control envelope is invalid.', 400);
  }
  assertAuthority(value.rpc, ['processFrame', 'close'], 'Native worker RPC session');
  if (!Number.isSafeInteger(value.rpc.maxConcurrentRequests)
    || value.rpc.maxConcurrentRequests < 1 || value.rpc.maxConcurrentRequests > 64) {
    throw new TypeError('Native worker RPC concurrency is invalid.');
  }
  validateSignal(value.signal);
  return value;
}

class AttestedNativeWorker {
  #process;
  #runRpc;
  #limits;
  #state = 'ready';
  #closePromise = null;

  constructor({ process, evidence, runRpc, limits }) {
    this.#process = process;
    this.evidence = evidence;
    this.#runRpc = runRpc;
    this.#limits = limits;
    Object.freeze(this.evidence);
  }

  async invoke(options) {
    if (this.#state !== 'ready') fail('PLUGIN_NATIVE_INVOCATION_STATE', 'The native plugin worker is not ready.', 409);
    const { control, rpc, signal } = validateInvokeOptions(options);
    this.#state = 'invoking';
    const controlCopy = Buffer.from(control);
    const header = encodeNativeInvocationPhase(controlCopy.length);
    try {
      const transport = Promise.resolve(this.#runRpc({
        readable: this.#process.rpcReadable,
        writable: this.#process.rpcWritable,
        session: rpc,
        signal,
        maxConcurrentRequests: rpc.maxConcurrentRequests,
      }));
      transport.catch(() => {});
      this.#process.beginInvocation();
      const completion = this.#process.nextFrame({
        timeoutMs: this.#limits.invokeTimeoutMs,
        signal,
        phase: 'its completion frame',
      });
      completion.catch(() => {});
      await this.#process.writeInvocation(header, controlCopy, {
        timeoutMs: this.#limits.invokeTimeoutMs,
        signal,
      });
      const [frame] = await Promise.all([
        completion,
        transport,
        this.#process.finish({ timeoutMs: this.#limits.invokeTimeoutMs, signal }),
      ]);
      this.#state = 'closed';
      return unframeNativeCompletion(frame);
    } catch (error) {
      try { await this.close('native-invocation-failed'); }
      catch (cleanupError) {
        fail(
          'PLUGIN_NATIVE_RUNTIME_CLEANUP_FAILED',
          'The native plugin invocation failed and its process could not be reaped.',
          500,
          new AggregateError([error, cleanupError], 'Native invocation and cleanup failed.'),
        );
      }
      if (signal?.aborted || error?.code === 'PLUGIN_NATIVE_CANCELLED'
        || error?.code === 'PLUGIN_TRANSPORT_CANCELLED') {
        fail('PLUGIN_NATIVE_CANCELLED', 'The native plugin operation was cancelled.', 499, error);
      }
      fail(
        'PLUGIN_NATIVE_INVOCATION_FAILED',
        'The native plugin process could not complete the operation.',
        500,
        error,
      );
    } finally {
      controlCopy.fill(0);
      header.fill(0);
    }
  }

  async close(reason = 'native-worker-close') {
    if (this.#state === 'closed') return false;
    if (this.#closePromise) return this.#closePromise;
    this.#state = 'closing';
    this.#closePromise = this.#process.close(reason, {
      graceMs: this.#limits.gracefulTerminationMs,
      reapMs: this.#limits.reapTimeoutMs,
    });
    try {
      const result = await this.#closePromise;
      this.#state = 'closed';
      return result;
    } catch (error) {
      this.#state = 'failed';
      this.#closePromise = null;
      throw error;
    }
  }
}

/**
 * Concrete host adapter for the signed, adjacent native supervisor/worker
 * pair. It remains unusable until the host supplies a signed release policy
 * and staged production artifacts that pass static and live macOS checks.
 */
export class PluginNativeSupervisor {
  #pair;
  #codeIdentity;
  #verifyExecutable;
  #spawnProcess;
  #spawnImpl;
  #killGroup;
  #probeGroup;
  #runRpc;
  #limits;

  constructor({
    supervisor,
    worker,
    policy,
    codeIdentity,
    verifyExecutable = verifyStagedNativeHelper,
    spawnProcess = spawnNativeSupervisor,
    spawnImpl,
    killGroup,
    probeGroup,
    runRpc = runPluginRpcTransport,
    limits,
  } = {}) {
    this.#pair = validateNativeExecutablePair({ supervisor, worker, policy });
    if (typeof verifyExecutable !== 'function' || typeof spawnProcess !== 'function'
      || (spawnImpl !== undefined && typeof spawnImpl !== 'function')
      || (killGroup !== undefined && typeof killGroup !== 'function')
      || (probeGroup !== undefined && typeof probeGroup !== 'function')
      || typeof runRpc !== 'function') {
      throw new TypeError('Native supervisor dependencies must be callable.');
    }
    this.#codeIdentity = codeIdentity ?? new DarwinPluginCodeIdentityVerifier({
      supervisor,
      worker,
      policy,
    });
    assertAuthority(
      this.#codeIdentity,
      ['verifyStaticPair', 'verifyLiveSupervisor', 'verifyLiveWorker'],
      'Native code identity verifier',
    );
    this.#verifyExecutable = verifyExecutable;
    this.#spawnProcess = spawnProcess;
    this.#spawnImpl = spawnImpl;
    this.#killGroup = killGroup;
    this.#probeGroup = probeGroup;
    this.#runRpc = runRpc;
    this.#limits = normalizeLimits(limits);
  }

  async launch({ identity, source, signal } = {}) {
    validateSignal(signal);
    const checked = validateNativeLaunch(identity, source);
    const sourceCopy = Buffer.from(checked.source);
    let process = null;
    try {
      await this.#verifyStagedPair();
      await this.#codeIdentity.verifyStaticPair({ signal });
      validateSignal(signal);
      process = await this.#spawnProcess({
        executable: this.#pair.supervisor.executable,
        spawnImpl: this.#spawnImpl,
        killGroup: this.#killGroup,
        probeGroup: this.#probeGroup,
      });
      await this.#codeIdentity.verifyLiveSupervisor({ pid: process.pid, signal });
      validateSignal(signal);
      const header = encodeNativePreparation(checked.identity, sourceCopy.length);
      try {
        await process.writePreparation(header, sourceCopy, {
          timeoutMs: this.#limits.launchTimeoutMs,
          signal,
        });
      } finally { header.fill(0); }
      sourceCopy.fill(0);
      const frame = await process.nextFrame({
        timeoutMs: this.#limits.launchTimeoutMs,
        signal,
        phase: 'its ready attestation',
      });
      process.assertReadyOnly();
      const evidence = decodeNativeReadyFrame(frame, {
        identity: checked.identity,
        supervisorPid: process.pid,
        policy: this.#pair.policy,
      });
      await this.#codeIdentity.verifyLiveWorker({ pid: evidence.workerPid, signal });
      validateSignal(signal);
      process.assertReadyOnly();
      return new AttestedNativeWorker({
        process,
        evidence,
        runRpc: this.#runRpc,
        limits: this.#limits,
      });
    } catch (error) {
      if (process) {
        try {
          await process.close('native-launch-failed', {
            graceMs: this.#limits.gracefulTerminationMs,
            reapMs: this.#limits.reapTimeoutMs,
          });
        } catch (cleanupError) {
          fail(
            'PLUGIN_NATIVE_LAUNCH_CLEANUP_FAILED',
            'The native plugin launch failed and its process could not be reaped.',
            500,
            new AggregateError([error, cleanupError], 'Native launch and cleanup failed.'),
          );
        }
      }
      if (error instanceof HostError) throw error;
      fail('PLUGIN_NATIVE_LAUNCH_FAILED', 'The native plugin supervisor could not be launched securely.', 503, error);
    } finally {
      sourceCopy.fill(0);
    }
  }

  async #verifyStagedPair() {
    try {
      await this.#verifyExecutable({
        executable: this.#pair.supervisor.executable,
        expectedSha256: this.#pair.policy.supervisorSha256,
        label: 'plugin supervisor',
      });
      await this.#verifyExecutable({
        executable: this.#pair.worker.executable,
        expectedSha256: this.#pair.policy.workerSha256,
        label: 'plugin worker',
      });
    } catch (error) {
      fail('PLUGIN_NATIVE_ARTIFACT_INVALID', 'The staged native plugin artifacts failed integrity verification.', 503, error);
    }
  }
}

export { DEFAULT_LIMITS as DEFAULT_PLUGIN_NATIVE_SUPERVISOR_LIMITS };
