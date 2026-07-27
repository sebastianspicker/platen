import { HostError } from './host-error.mjs';

/**
 * Strict, one-shot worker-control envelopes for a future native supervisor.
 * This module validates bytes and messages only: it does not create a process,
 * load a package, resolve an entry point, or otherwise execute plugin code.
 */
export const PLUGIN_WORKER_CONTROL_PROTOCOL = 1;
export const DEFAULT_PLUGIN_WORKER_CONTROL_LIMITS = Object.freeze({
  maxEnvelopeBytes: 64 * 1024,
  maxResultBytes: 64 * 1024,
  maxDepth: 8,
  maxObjectKeys: 64,
  maxArrayLength: 256,
  maxStringLength: 8 * 1024,
});

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
const BINDING_ID = /^[A-Za-z0-9_-]{16,128}$/;
const HANDLE = /^pdfh_[0-9a-f]{64}$/;
const UNSAFE_KEY = /^(?:__proto__|prototype|constructor)$/i;
const FORBIDDEN_KEY = /^(?:path|paths|source|sourceid|document|documentid|environment|env|executable|entry|entrypath|command|argv|cwd)$/i;
const COMMON_FIELDS = Object.freeze([
  'protocol', 'pluginId', 'version', 'packageHash', 'activationId', 'operationId', 'nonce', 'type',
]);
const FAILURE = Object.freeze({
  code: 'PLUGIN_WORKER_FAILED',
  message: 'The plugin operation could not be completed.',
});

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('PLUGIN_WORKER_CONTROL_INVALID', `${label} must be a plain JSON object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('PLUGIN_WORKER_CONTROL_INVALID', `${label} has unsupported or missing fields.`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cloneAndFreezeJson(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreezeJson));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneAndFreezeJson(item)]),
    ));
  }
  return value;
}

function assertJson(value, limits, depth = 0) {
  if (depth > limits.maxDepth) fail('PLUGIN_WORKER_CONTROL_TOO_DEEP', 'Worker-control data exceeds the nesting limit.', 413);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PLUGIN_WORKER_CONTROL_INVALID', 'Worker-control numbers must be finite.');
    return;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > limits.maxStringLength) fail('PLUGIN_WORKER_CONTROL_TOO_LARGE', 'Worker-control data contains an overlong UTF-8 string.', 413);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) fail('PLUGIN_WORKER_CONTROL_TOO_LARGE', 'Worker-control data contains an oversized array.', 413);
    for (const item of value) assertJson(item, limits, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('PLUGIN_WORKER_CONTROL_INVALID', 'Worker-control data must contain JSON-safe values.');
  }
  const keys = Object.keys(value);
  if (keys.length > limits.maxObjectKeys) fail('PLUGIN_WORKER_CONTROL_TOO_LARGE', 'Worker-control data contains too many object keys.', 413);
  for (const key of keys) {
    if (UNSAFE_KEY.test(key) || FORBIDDEN_KEY.test(key)) {
      fail('PLUGIN_WORKER_CONTROL_INVALID', 'Worker-control data contains a forbidden field.');
    }
    assertJson(value[key], limits, depth + 1);
  }
}

export function normalizePluginWorkerControlLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('Worker-control limits must be an object.');
  const limits = { ...DEFAULT_PLUGIN_WORKER_CONTROL_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('Worker-control limits must contain supported positive integers.');
    }
    limits[key] = value;
  }
  if (limits.maxResultBytes > limits.maxEnvelopeBytes) throw new TypeError('Worker-control result bytes cannot exceed envelope bytes.');
  return Object.freeze(limits);
}

export function validatePluginWorkerControlBinding(binding) {
  exactKeys(binding, ['pluginId', 'version', 'packageHash', 'activationId', 'operationId', 'nonce'], 'Worker-control binding');
  if (!PLUGIN_ID.test(binding.pluginId) || !SEMVER.test(binding.version) || !SHA256.test(binding.packageHash)
    || !BINDING_ID.test(binding.activationId) || !BINDING_ID.test(binding.operationId) || !SHA256.test(binding.nonce)) {
    throw new TypeError('Worker-control binding is invalid.');
  }
  return Object.freeze({ ...binding });
}

function validateCommon(message, binding) {
  if (message.protocol !== PLUGIN_WORKER_CONTROL_PROTOCOL || !['invoke', 'completion', 'failure', 'cancellation'].includes(message.type)) {
    fail('PLUGIN_WORKER_CONTROL_INVALID', 'Worker-control envelope is invalid.');
  }
  for (const field of ['pluginId', 'version', 'packageHash', 'activationId', 'operationId', 'nonce']) {
    if (message[field] !== binding[field]) fail('PLUGIN_WORKER_CONTROL_BINDING_MISMATCH', 'Worker-control binding failed.', 403);
  }
}

export function validatePluginWorkerControlMessage(message, binding, { limits } = {}) {
  const checkedBinding = validatePluginWorkerControlBinding(binding);
  const checkedLimits = normalizePluginWorkerControlLimits(limits);
  const fields = message?.type === 'invoke' ? [...COMMON_FIELDS, 'capability', 'documentHandle', 'input']
    : message?.type === 'completion' ? [...COMMON_FIELDS, 'result']
      : message?.type === 'failure' ? [...COMMON_FIELDS, 'failure'] : COMMON_FIELDS;
  exactKeys(message, fields, 'Worker-control envelope');
  validateCommon(message, checkedBinding);
  if (message.type === 'invoke') {
    if (!CAPABILITY_ID.test(message.capability)) fail('PLUGIN_WORKER_CONTROL_INVALID', 'Worker-control capability is invalid.');
    if (!HANDLE.test(message.documentHandle)) fail('PLUGIN_WORKER_CONTROL_INVALID', 'Worker-control document handle is invalid.');
    assertJson(message.input, checkedLimits);
  } else if (message.type === 'completion') {
    assertJson(message.result, checkedLimits);
    if (Buffer.byteLength(canonicalJson(message.result), 'utf8') > checkedLimits.maxResultBytes) {
      fail('PLUGIN_WORKER_CONTROL_RESULT_TOO_LARGE', 'Worker-control result exceeds the byte limit.', 413);
    }
  } else if (message.type === 'failure') {
    exactKeys(message.failure, ['code', 'message'], 'Worker-control failure');
    if (message.failure.code !== FAILURE.code || message.failure.message !== FAILURE.message) {
      fail('PLUGIN_WORKER_CONTROL_INVALID', 'Worker-control failure is not sanitized.');
    }
  }
  assertJson(message, checkedLimits);
  if (Buffer.byteLength(canonicalJson(message), 'utf8') > checkedLimits.maxEnvelopeBytes) {
    fail('PLUGIN_WORKER_CONTROL_ENVELOPE_TOO_LARGE', 'Worker-control envelope exceeds the byte limit.', 413);
  }
  return cloneAndFreezeJson(message);
}

export function encodePluginWorkerControl(value, { binding, limits } = {}) {
  const checkedLimits = normalizePluginWorkerControlLimits(limits);
  const validated = validatePluginWorkerControlMessage(value, binding, { limits: checkedLimits });
  return Buffer.from(canonicalJson(validated), 'utf8');
}

export function decodePluginWorkerControl(bytes, { binding, limits } = {}) {
  const checkedLimits = normalizePluginWorkerControlLimits(limits);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('PLUGIN_WORKER_CONTROL_INVALID', 'Worker-control envelope must be bytes.');
  const body = Buffer.from(bytes);
  if (body.length > checkedLimits.maxEnvelopeBytes) fail('PLUGIN_WORKER_CONTROL_ENVELOPE_TOO_LARGE', 'Worker-control envelope exceeds the byte limit.', 413);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { fail('PLUGIN_WORKER_CONTROL_INVALID_UTF8', 'Worker-control envelope is not valid UTF-8.'); }
  let value;
  try { value = JSON.parse(text); } catch { fail('PLUGIN_WORKER_CONTROL_INVALID_JSON', 'Worker-control envelope is not valid JSON.'); }
  if (canonicalJson(value) !== text) fail('PLUGIN_WORKER_CONTROL_NON_CANONICAL', 'Worker-control envelope is not canonical JSON.');
  return validatePluginWorkerControlMessage(value, binding, { limits: checkedLimits });
}

export function createPluginWorkerFailure(binding) {
  const checkedBinding = validatePluginWorkerControlBinding(binding);
  return Object.freeze({ protocol: PLUGIN_WORKER_CONTROL_PROTOCOL, ...checkedBinding, type: 'failure', failure: FAILURE });
}

export function createPluginWorkerInvocation({
  binding,
  declaredCapabilities,
  capability,
  documentHandle,
  input,
  limits,
} = {}) {
  if (!Array.isArray(declaredCapabilities) || declaredCapabilities.length === 0
    || declaredCapabilities.length > 64 || new Set(declaredCapabilities).size !== declaredCapabilities.length
    || declaredCapabilities.some((value) => !CAPABILITY_ID.test(value))) {
    throw new TypeError('declaredCapabilities must be a non-empty unique capability list.');
  }
  if (!declaredCapabilities.includes(capability)) {
    fail('PLUGIN_WORKER_CAPABILITY_UNDECLARED', 'The signed package does not declare this capability.', 403);
  }
  const checkedBinding = validatePluginWorkerControlBinding(binding);
  return validatePluginWorkerControlMessage({
    protocol: PLUGIN_WORKER_CONTROL_PROTOCOL,
    ...checkedBinding,
    type: 'invoke',
    capability,
    documentHandle,
    input,
  }, checkedBinding, { limits });
}
