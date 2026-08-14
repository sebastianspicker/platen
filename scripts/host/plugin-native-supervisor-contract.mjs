import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { HostError } from './host-error.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const CODE_HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const TEAM_ID = /^[A-Z0-9]{10}$/u;
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.][a-z0-9-]+)+$/u;
const SEMVER = /^(0|[1-9]\d*)[.](0|[1-9]\d*)[.](0|[1-9]\d*)$/u;
const SUPERVISOR_NAME = 'PDFPluginSupervisor';
const WORKER_NAME = 'PDFPluginWorker';
const SUPERVISOR_IDENTIFIER = 'org.platen.PDFPluginSupervisor';
const WORKER_IDENTIFIER = 'org.platen.PDFPluginWorker';
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;

export const NATIVE_READY_BOOLEAN_FIELDS = Object.freeze([
  'staticCodeIdentity', 'liveCodeIdentity', 'appSandbox', 'noNetwork',
  'cpuQuota', 'hardMemoryQuota', 'processQuota', 'outputQuota',
  'privateIpc', 'sourceBytesOnly',
]);

const RELEASE_POLICY_FIELDS = Object.freeze([
  'schema', 'version', 'teamIdentifier', 'supervisorSha256', 'workerSha256',
  'supervisorCdHash', 'workerCdHash', 'designatedRequirementSha256',
]);
const LAUNCH_IDENTITY_FIELDS = Object.freeze([
  'pluginId', 'version', 'packageHash', 'sourceSha256', 'runtime',
]);
const RUNTIME_FIELDS = Object.freeze(['kind', 'apiVersion', 'entry', 'sha256']);
const WIRE_READY_FIELDS = Object.freeze([
  'schema', 'protocol', 'type', 'pluginId', 'pluginVersion', 'packageHash',
  'sourceSha256', 'supervisorPid', 'workerPid', 'teamIdentifier',
  'supervisorCdHash', 'workerCdHash', 'designatedRequirementSha256',
  ...NATIVE_READY_BOOLEAN_FIELDS,
]);

function fail(code, message, status = 500, cause) {
  throw new HostError(code, message, status, cause === undefined ? {} : { cause });
}

function exactPlainObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unsupported or missing fields.`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requirementText(identifier, teamIdentifier) {
  return `anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "${teamIdentifier}"`;
}

export function nativeDesignatedRequirements(teamIdentifier) {
  if (!TEAM_ID.test(teamIdentifier ?? '')) throw new TypeError('Native release Team ID is invalid.');
  const supervisor = requirementText(SUPERVISOR_IDENTIFIER, teamIdentifier);
  const worker = requirementText(WORKER_IDENTIFIER, teamIdentifier);
  const sha256 = createHash('sha256').update(`${supervisor}\n${worker}`).digest('hex');
  return Object.freeze({ supervisor, worker, sha256 });
}

export function validateNativeReleasePolicy(value) {
  exactPlainObject(value, RELEASE_POLICY_FIELDS, 'Native plugin release policy');
  const requirements = nativeDesignatedRequirements(value.teamIdentifier);
  if (value.schema !== 'pdf-plugin-native-release-policy-v1' || value.version !== 1
    || !SHA256.test(value.supervisorSha256) || !SHA256.test(value.workerSha256)
    || !CODE_HASH.test(value.supervisorCdHash) || !CODE_HASH.test(value.workerCdHash)
    || !SHA256.test(value.designatedRequirementSha256)
    || value.designatedRequirementSha256 !== requirements.sha256) {
    throw new TypeError('Native plugin release policy is invalid or does not bind its designated requirements.');
  }
  return Object.freeze({ ...value });
}

function validateExecutable(value, expectedName, expectedSha256) {
  exactPlainObject(value, ['executable', 'sha256'], `Staged ${expectedName}`);
  if (typeof value.executable !== 'string' || !isAbsolute(value.executable)
    || value.executable.includes('\0') || value.sha256 !== expectedSha256
    || resolve(value.executable) !== value.executable
    || value.executable.slice(value.executable.lastIndexOf('/') + 1) !== expectedName) {
    throw new TypeError(`Staged ${expectedName} is not the pinned absolute executable.`);
  }
  return Object.freeze({ ...value });
}

export function validateNativeExecutablePair({ supervisor, worker, policy } = {}) {
  const checkedPolicy = validateNativeReleasePolicy(policy);
  const checkedSupervisor = validateExecutable(supervisor, SUPERVISOR_NAME, checkedPolicy.supervisorSha256);
  const checkedWorker = validateExecutable(worker, WORKER_NAME, checkedPolicy.workerSha256);
  if (dirname(checkedSupervisor.executable) !== dirname(checkedWorker.executable)) {
    throw new TypeError('The staged native supervisor and worker must be adjacent.');
  }
  return Object.freeze({
    supervisor: checkedSupervisor,
    worker: checkedWorker,
    policy: checkedPolicy,
    requirements: nativeDesignatedRequirements(checkedPolicy.teamIdentifier),
  });
}

export function validateNativeLaunch(identity, source) {
  exactPlainObject(identity, LAUNCH_IDENTITY_FIELDS, 'Native plugin launch identity');
  exactPlainObject(identity.runtime, RUNTIME_FIELDS, 'Native plugin runtime identity');
  if (!Buffer.isBuffer(source) || source.length < 1 || source.length > MAX_SOURCE_BYTES
    || !PLUGIN_ID.test(identity.pluginId ?? '') || !SEMVER.test(identity.version ?? '')
    || !SHA256.test(identity.packageHash ?? '') || !SHA256.test(identity.sourceSha256 ?? '')
    || identity.runtime.kind !== 'javascriptcore-classic-script'
    || identity.runtime.apiVersion !== 1 || typeof identity.runtime.entry !== 'string'
    || identity.runtime.sha256 !== identity.sourceSha256
    || createHash('sha256').update(source).digest('hex') !== identity.sourceSha256) {
    fail('PLUGIN_NATIVE_LAUNCH_INVALID', 'The native plugin launch input is invalid.', 400);
  }
  return Object.freeze({
    identity: Object.freeze({ ...identity, runtime: Object.freeze({ ...identity.runtime }) }),
    source,
  });
}

export function encodeNativePreparation(identity, sourceBytes) {
  const header = {
    packageHash: identity.packageHash,
    pluginId: identity.pluginId,
    sourceBytes,
    sourceSha256: identity.sourceSha256,
    version: identity.version,
  };
  return Buffer.from(`${canonicalJson(header)}\n`, 'utf8');
}

export function encodeNativeInvocationPhase(controlBytes) {
  if (!Number.isSafeInteger(controlBytes) || controlBytes < 1 || controlBytes > MAX_FRAME_BYTES) {
    fail('PLUGIN_NATIVE_CONTROL_INVALID', 'The native plugin control envelope is invalid.', 400);
  }
  return Buffer.from(`${canonicalJson({ controlBytes })}\n`, 'utf8');
}

function decodeCanonicalFrame(frame, label) {
  if (!Buffer.isBuffer(frame) || frame.length < 5) fail('PLUGIN_NATIVE_PROTOCOL_INVALID', `${label} is invalid.`, 502);
  const length = frame.readUInt32BE(0);
  if (length < 1 || length > MAX_FRAME_BYTES || frame.length !== length + 4) {
    fail('PLUGIN_NATIVE_PROTOCOL_INVALID', `${label} has invalid framing.`, 502);
  }
  const payload = frame.subarray(4);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload); }
  catch (error) { fail('PLUGIN_NATIVE_PROTOCOL_INVALID', `${label} is not valid UTF-8.`, 502, error); }
  let value;
  try { value = JSON.parse(text); }
  catch (error) { fail('PLUGIN_NATIVE_PROTOCOL_INVALID', `${label} is not valid JSON.`, 502, error); }
  if (canonicalJson(value) !== text) fail('PLUGIN_NATIVE_PROTOCOL_INVALID', `${label} is not canonical JSON.`, 502);
  return { payload, value };
}

export function decodeNativeReadyFrame(frame, { identity, supervisorPid, policy } = {}) {
  const checkedPolicy = validateNativeReleasePolicy(policy);
  const { value } = decodeCanonicalFrame(frame, 'Native plugin ready frame');
  try { exactPlainObject(value, WIRE_READY_FIELDS, 'Native plugin ready frame'); }
  catch (error) { fail('PLUGIN_NATIVE_ATTESTATION_FAILED', 'The native plugin ready attestation is invalid.', 503, error); }
  if (value.schema !== 'pdf-plugin-native-attestation-v1' || value.protocol !== 1 || value.type !== 'ready'
    || value.pluginId !== identity?.pluginId || value.pluginVersion !== identity?.version
    || value.packageHash !== identity?.packageHash || value.sourceSha256 !== identity?.sourceSha256
    || !Number.isSafeInteger(value.supervisorPid) || value.supervisorPid !== supervisorPid
    || !Number.isSafeInteger(value.workerPid) || value.workerPid < 1 || value.workerPid === supervisorPid
    || value.teamIdentifier !== checkedPolicy.teamIdentifier
    || value.supervisorCdHash !== checkedPolicy.supervisorCdHash
    || value.workerCdHash !== checkedPolicy.workerCdHash
    || value.designatedRequirementSha256 !== checkedPolicy.designatedRequirementSha256
    || NATIVE_READY_BOOLEAN_FIELDS.some((field) => value[field] !== true)) {
    fail('PLUGIN_NATIVE_ATTESTATION_FAILED', 'The native plugin ready attestation did not satisfy release policy.', 503);
  }
  const evidence = {
    schema: value.schema, version: 1, pluginId: value.pluginId,
    pluginVersion: value.pluginVersion, packageHash: value.packageHash,
    sourceSha256: value.sourceSha256, supervisorPid: value.supervisorPid,
    workerPid: value.workerPid, teamIdentifier: value.teamIdentifier,
    supervisorCdHash: value.supervisorCdHash, workerCdHash: value.workerCdHash,
    designatedRequirementSha256: value.designatedRequirementSha256,
  };
  for (const field of NATIVE_READY_BOOLEAN_FIELDS) evidence[field] = value[field];
  return Object.freeze(evidence);
}

export function unframeNativeCompletion(frame) {
  return Buffer.from(decodeCanonicalFrame(frame, 'Native plugin completion frame').payload);
}

export const NATIVE_PLUGIN_IDENTIFIERS = Object.freeze({
  supervisor: SUPERVISOR_IDENTIFIER,
  worker: WORKER_IDENTIFIER,
});
export const NATIVE_PLUGIN_PROTOCOL_LIMITS = Object.freeze({
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxFrameBytes: MAX_FRAME_BYTES,
});
