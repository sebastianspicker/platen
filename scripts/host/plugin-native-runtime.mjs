import { createHash } from 'node:crypto';
import { HostError } from './host-error.mjs';
import { createPluginOperationSession } from './plugin-operation-session.mjs';
import { validatePluginLaunchDescriptor } from './plugin-operation-session-contract.mjs';
import {
  decodePluginWorkerControl,
  encodePluginWorkerControl,
} from './plugin-worker-control.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const CODE_HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const TEAM_ID = /^[A-Z0-9]{10}$/u;
const RUNTIME_KIND = 'javascriptcore-classic-script';
const HARD_ATTESTATION_FIELDS = Object.freeze([
  'staticCodeIdentity', 'liveCodeIdentity', 'appSandbox', 'noNetwork',
  'cpuQuota', 'hardMemoryQuota', 'processQuota', 'outputQuota',
  'privateIpc', 'sourceBytesOnly',
]);
const ATTESTATION_FIELDS = Object.freeze([
  'schema', 'version', 'pluginId', 'pluginVersion', 'packageHash', 'sourceSha256',
  'supervisorPid', 'workerPid', 'teamIdentifier', 'supervisorCdHash',
  'workerCdHash', 'designatedRequirementSha256', ...HARD_ATTESTATION_FIELDS,
]);

function fail(code, message, status = 500, cause) {
  throw new HostError(code, message, status, cause === undefined ? {} : { cause });
}

function nativeBoundaryFailure(error, phase, signal) {
  if (signal?.aborted) return new HostError('PLUGIN_WORKER_CANCELLED', 'The plugin operation was cancelled.', 499, { cause: error });
  return phase === 'launch'
    ? new HostError('PLUGIN_NATIVE_LAUNCH_FAILED', 'The native plugin worker could not be launched securely.', 503, { cause: error })
    : new HostError('PLUGIN_WORKER_FAILED', 'The plugin operation could not be completed.', 500, { cause: error });
}

function assertAuthority(value, methods, label) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`${label} does not implement the required authority.`);
  }
}

function assertExecutableLaunch(value, pluginId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'descriptor')
    || !Object.hasOwn(value, 'source') || !Buffer.isBuffer(value.source)) {
    fail('PLUGIN_EXECUTABLE_LAUNCH_INVALID', 'The package store returned an invalid executable launch.', 500);
  }
  const descriptor = validatePluginLaunchDescriptor(value.descriptor, pluginId);
  const runtime = descriptor?.executableRuntime;
  const entry = descriptor?.inventory?.find((file) => file.path === runtime?.entry);
  if (descriptor?.id !== pluginId || descriptor?.digest !== descriptor?.packageHash
    || !SHA256.test(descriptor?.digest ?? '') || !runtime
    || Object.keys(runtime).length !== 4
    || runtime.kind !== RUNTIME_KIND || runtime.apiVersion !== 1
    || runtime.entry !== descriptor.manifest?.entry || !SHA256.test(runtime.sha256 ?? '')
    || !entry || entry.sha256 !== runtime.sha256 || value.source.length < 1
    || value.source.length !== entry.size
    || createHash('sha256').update(value.source).digest('hex') !== runtime.sha256) {
    fail('PLUGIN_EXECUTABLE_LAUNCH_INVALID', 'The signed package is not an executable manifest-v3 launch.', 409);
  }
  return Object.freeze({ descriptor, source: value.source });
}

function assertAttestedWorker(worker, identity) {
  const evidence = worker?.evidence;
  if (!worker || typeof worker !== 'object' || typeof worker.invoke !== 'function'
    || typeof worker.close !== 'function' || !evidence
    || Object.keys(evidence).length !== ATTESTATION_FIELDS.length
    || Object.keys(evidence).some((field) => !ATTESTATION_FIELDS.includes(field))
    || evidence.schema !== 'pdf-plugin-native-attestation-v1' || evidence.version !== 1
    || evidence.pluginId !== identity.pluginId || evidence.pluginVersion !== identity.version
    || evidence.packageHash !== identity.packageHash || evidence.sourceSha256 !== identity.sourceSha256
    || !Number.isSafeInteger(evidence.supervisorPid) || evidence.supervisorPid < 1
    || !Number.isSafeInteger(evidence.workerPid) || evidence.workerPid < 1
    || evidence.supervisorPid === evidence.workerPid || !TEAM_ID.test(evidence.teamIdentifier ?? '')
    || !CODE_HASH.test(evidence.supervisorCdHash ?? '') || !CODE_HASH.test(evidence.workerCdHash ?? '')
    || !SHA256.test(evidence.designatedRequirementSha256 ?? '')
    || HARD_ATTESTATION_FIELDS.some((field) => evidence[field] !== true)) {
    fail('PLUGIN_NATIVE_ATTESTATION_FAILED', 'The native plugin worker did not satisfy the complete launch attestation.', 503);
  }
  return worker;
}

function launchIdentity(descriptor) {
  return Object.freeze({
    pluginId: descriptor.id,
    version: descriptor.version,
    packageHash: descriptor.digest,
    sourceSha256: descriptor.executableRuntime.sha256,
    runtime: descriptor.executableRuntime,
  });
}

function exactLaunchAuthority(descriptor) {
  return Object.freeze({ async getLaunchDescriptor() { return descriptor; } });
}

function rpcAuthority(session) {
  return Object.freeze({
    processFrame(frame) { return session.processFrame(frame); },
    close(reason) { return session.close(reason); },
    maxConcurrentRequests: session.maxConcurrentRequests,
  });
}

function completionResult(bytes, binding) {
  const message = decodePluginWorkerControl(bytes, { binding });
  if (message.type === 'completion') return message.result;
  if (message.type === 'cancellation') {
    fail('PLUGIN_WORKER_CANCELLED', 'The plugin operation was cancelled.', 499);
  }
  fail('PLUGIN_WORKER_FAILED', 'The plugin operation could not be completed.', 500);
}

function createRuntimeTeardown({ session, worker }) {
  let sessionClosed = false; let workerClosed = false; let inFlight = null;
  return async (reason, primaryError = null) => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const errors = [];
      if (!sessionClosed) {
        try { session.close(reason); sessionClosed = true; } catch (error) { errors.push(error); }
      }
      if (!workerClosed) {
        try { await worker.close(reason); workerClosed = true; } catch (error) { errors.push(error); }
      }
      if (errors.length !== 0) {
        fail(
          'PLUGIN_NATIVE_RUNTIME_CLEANUP_FAILED',
          'The native plugin runtime could not revoke authority and terminate cleanly.',
          500,
          new AggregateError(primaryError ? [primaryError, ...errors] : errors, 'Plugin runtime cleanup failed.'),
        );
      }
    })();
    try { return await inFlight; } finally { inFlight = null; }
  };
}

/**
 * One-shot production authority coordinator. The injected native supervisor must
 * finish static and live identity/sandbox attestation before this class issues a
 * grant or document handle. The default repository ships no signed supervisor,
 * so construction alone never makes plugin execution available.
 */
export class PluginNativeRuntime {
  #packages;
  #grants;
  #handles;
  #supervisor;
  #activations;
  #audit;
  #createSession;

  constructor({ packages, grants, handles, supervisor, activations, audit = () => {}, createSession = createPluginOperationSession } = {}) {
    assertAuthority(packages, ['getExecutableLaunch'], 'Plugin package store');
    assertAuthority(grants, ['issue', 'revokeActivation'], 'Plugin grant store');
    assertAuthority(handles, ['issue', 'getMetadata', 'readRange', 'revokeActivation'], 'Plugin document handle store');
    assertAuthority(supervisor, ['launch'], 'Native plugin supervisor');
    assertAuthority(activations, ['register'], 'Plugin runtime authority registry');
    if (typeof audit !== 'function' || typeof createSession !== 'function') throw new TypeError('audit and createSession must be callable.');
    this.#packages = packages;
    this.#grants = grants;
    this.#handles = handles;
    this.#supervisor = supervisor;
    this.#activations = activations;
    this.#audit = audit;
    this.#createSession = createSession;
  }

  async invoke({ pluginId, documentId, permissions, methods, capability, input, signal, rpcLimits } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    if (signal?.aborted) fail('PLUGIN_WORKER_CANCELLED', 'The plugin operation was cancelled.', 499);
    const executable = assertExecutableLaunch(await this.#packages.getExecutableLaunch(pluginId), pluginId);
    const source = Buffer.from(executable.source);
    executable.source.fill(0);
    let worker = null;
    let session = null;
    let registration = null;
    let teardown = null;
    let primaryError = null;
    let result;
    try {
      const identity = launchIdentity(executable.descriptor);
      try {
        worker = await this.#supervisor.launch({ identity, source, signal });
        assertAttestedWorker(worker, identity);
      } catch (error) {
        if (error instanceof HostError && error.code === 'PLUGIN_NATIVE_ATTESTATION_FAILED') throw error;
        throw nativeBoundaryFailure(error, 'launch', signal);
      }
      this.#audit({
        type: 'plugin.native-worker.attested', pluginId,
        version: executable.descriptor.version, packageHash: executable.descriptor.digest,
      });
      if (signal?.aborted) fail('PLUGIN_WORKER_CANCELLED', 'The plugin operation was cancelled.', 499);
      session = await this.#createSession({
        packages: exactLaunchAuthority(executable.descriptor),
        grants: this.#grants,
        handles: this.#handles,
        pluginId,
        documentId,
        permissions,
        methods,
        rpcLimits,
        signal,
        audit: this.#audit,
      });
      teardown = createRuntimeTeardown({ session, worker });
      if (signal?.aborted) fail('PLUGIN_WORKER_CANCELLED', 'The plugin operation was cancelled.', 499);
      registration = await this.#activations.register({
        binding: session.binding,
        terminate: (reason) => teardown(reason),
      });
      if (signal?.aborted) fail('PLUGIN_WORKER_CANCELLED', 'The plugin operation was cancelled.', 499);
      const invocation = session.createInvocation(capability, input);
      const control = encodePluginWorkerControl(invocation, { binding: session.binding });
      let completion;
      try {
        completion = await worker.invoke({ control, rpc: rpcAuthority(session), signal });
      } catch (error) {
        throw nativeBoundaryFailure(error, 'invoke', signal);
      }
      result = completionResult(completion, session.binding);
      this.#audit({
        type: 'plugin.native-worker.completed', pluginId,
        version: executable.descriptor.version, packageHash: executable.descriptor.digest,
        activationId: session.binding.activationId, operationId: session.binding.operationId,
      });
    } catch (error) {
      primaryError = error;
    } finally {
      source.fill(0);
      if (teardown) {
        await teardown(primaryError ? 'native-worker-failed' : 'native-worker-completed', primaryError);
      } else if (worker) {
        try { await worker.close(primaryError ? 'native-worker-failed' : 'native-worker-completed'); }
        catch (error) { throw nativeBoundaryFailure(error, 'invoke', signal); }
      }
      await registration?.release();
    }
    if (primaryError) throw primaryError;
    return result;
  }
}

export { HARD_ATTESTATION_FIELDS as PLUGIN_NATIVE_HARD_ATTESTATION_FIELDS };
