import { HostError } from './host-error.mjs';

export const PLUGIN_RPC_PROTOCOL = 1;
export const DEFAULT_PLUGIN_RPC_LIMITS = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxResultBytes: 64 * 1024,
  maxDepth: 8,
  maxObjectKeys: 64,
  maxArrayLength: 256,
  maxStringLength: 8 * 1024,
  maxInFlight: 4,
  maxRequestsPerMinute: 120,
  maxSessionRequests: 10_000,
  requestTimeoutMs: 15_000,
});

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BINDING_ID = /^[A-Za-z0-9_-]{16,128}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HANDLE = /^pdfh_[0-9a-f]{64}$/;
const UNSAFE_KEY = /^(?:__proto__|prototype|constructor)$/i;
const COMMON_FIELDS = Object.freeze([
  'protocol', 'nonce', 'pluginId', 'version', 'packageHash', 'activationId', 'type', 'id', 'sequence',
]);

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

export function normalizePluginRpcLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('RPC limits must be an object.');
  const limits = { ...DEFAULT_PLUGIN_RPC_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('RPC limits must contain supported positive integers.');
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('PLUGIN_RPC_INVALID', `${label} must be a plain JSON object.`);
  }
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail('PLUGIN_RPC_INVALID', `${label} has unsupported or missing fields.`);
  }
}

export function assertPluginRpcJsonShape(value, limits, depth = 0) {
  if (depth > limits.maxDepth) fail('PLUGIN_RPC_TOO_DEEP', 'Plugin RPC data exceeds the nesting limit.', 413);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PLUGIN_RPC_INVALID', 'Plugin RPC numbers must be finite.');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > limits.maxStringLength) fail('PLUGIN_RPC_TOO_LARGE', 'Plugin RPC data contains an overlong string.', 413);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) fail('PLUGIN_RPC_TOO_LARGE', 'Plugin RPC data contains an oversized array.', 413);
    for (const item of value) assertPluginRpcJsonShape(item, limits, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('PLUGIN_RPC_INVALID', 'Plugin RPC data must contain JSON-safe values.');
  }
  const keys = Object.keys(value);
  if (keys.length > limits.maxObjectKeys) fail('PLUGIN_RPC_TOO_LARGE', 'Plugin RPC data contains too many object keys.', 413);
  for (const key of keys) {
    if (UNSAFE_KEY.test(key)) fail('PLUGIN_RPC_INVALID', 'Plugin RPC data contains an unsafe object key.');
    assertPluginRpcJsonShape(value[key], limits, depth + 1);
  }
}

export function encodePluginRpcFrame(value, { maxBytes = DEFAULT_PLUGIN_RPC_LIMITS.maxFrameBytes, limits } = {}) {
  const checkedLimits = limits ?? normalizePluginRpcLimits({ maxFrameBytes: maxBytes });
  assertPluginRpcJsonShape(value, checkedLimits);
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > maxBytes) fail('PLUGIN_RPC_FRAME_TOO_LARGE', 'Plugin RPC frame exceeds the byte limit.', 413);
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function decodePluginRpcFrame(frame, { maxBytes = DEFAULT_PLUGIN_RPC_LIMITS.maxFrameBytes, limits } = {}) {
  if (!Buffer.isBuffer(frame) && !(frame instanceof Uint8Array)) fail('PLUGIN_RPC_INVALID_FRAME', 'Plugin RPC frame must be bytes.');
  const bytes = Buffer.from(frame);
  if (bytes.length < 4) fail('PLUGIN_RPC_TRUNCATED', 'Plugin RPC frame header is truncated.');
  const declaredLength = bytes.readUInt32BE(0);
  if (declaredLength > maxBytes) fail('PLUGIN_RPC_FRAME_TOO_LARGE', 'Plugin RPC frame prefix exceeds the byte limit.', 413);
  if (bytes.length !== declaredLength + 4) fail('PLUGIN_RPC_TRUNCATED', 'Plugin RPC frame length does not match its prefix.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4));
  } catch {
    fail('PLUGIN_RPC_INVALID_UTF8', 'Plugin RPC frame is not valid UTF-8.');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('PLUGIN_RPC_INVALID_JSON', 'Plugin RPC frame is not valid JSON.');
  }
  assertPluginRpcJsonShape(value, limits ?? normalizePluginRpcLimits({ maxFrameBytes: maxBytes }));
  return value;
}

export function validatePluginRpcBinding(binding) {
  assertExactFields(binding, ['pluginId', 'version', 'packageHash', 'activationId', 'operationId', 'nonce'], 'RPC session binding');
  if (!PLUGIN_ID.test(binding.pluginId) || !SEMVER.test(binding.version) || !SHA256.test(binding.packageHash)
    || !BINDING_ID.test(binding.activationId) || !BINDING_ID.test(binding.operationId)
    || !/^[0-9a-f]{64}$/.test(binding.nonce)) {
    throw new TypeError('RPC session binding is invalid.');
  }
  return Object.freeze({ ...binding });
}

export function validatePluginRpcEnvelope(message, binding) {
  const fields = message?.type === 'request' ? [...COMMON_FIELDS, 'method', 'params']
    : message?.type === 'cancel' ? [...COMMON_FIELDS, 'targetId'] : COMMON_FIELDS;
  assertExactFields(message, fields, 'RPC message');
  if (message.protocol !== PLUGIN_RPC_PROTOCOL || !['request', 'cancel'].includes(message.type)
    || !MESSAGE_ID.test(message.id) || !Number.isSafeInteger(message.sequence) || message.sequence < 1) {
    fail('PLUGIN_RPC_INVALID', 'Plugin RPC envelope is invalid.');
  }
  if (message.nonce !== binding.nonce || message.pluginId !== binding.pluginId
    || message.version !== binding.version || message.packageHash !== binding.packageHash
    || message.activationId !== binding.activationId) {
    fail('PLUGIN_RPC_BINDING_MISMATCH', 'Plugin RPC channel binding failed.', 403);
  }
  if (message.type === 'cancel' && !MESSAGE_ID.test(message.targetId)) fail('PLUGIN_RPC_INVALID', 'Plugin cancellation target is invalid.');
  return message;
}

function boundResult(message, value) {
  return {
    protocol: PLUGIN_RPC_PROTOCOL,
    nonce: message.nonce,
    pluginId: message.pluginId,
    version: message.version,
    packageHash: message.packageHash,
    activationId: message.activationId,
    type: 'result',
    id: message.id,
    sequence: message.sequence,
    value,
  };
}

export function maxRpcReadRangeBytes(message, limits = DEFAULT_PLUGIN_RPC_LIMITS) {
  let low = 0;
  let high = Math.max(0, Math.floor(limits.maxStringLength * 3 / 4));
  while (low < high) {
    const candidate = Math.ceil((low + high + 1) / 2);
    const encodedLength = Math.ceil(candidate / 3) * 4;
    const value = { encoding: 'base64', byteLength: candidate, data: 'A'.repeat(encodedLength) };
    const fits = encodedLength <= limits.maxStringLength
      && Buffer.byteLength(JSON.stringify(boundResult(message, value)), 'utf8') <= limits.maxResultBytes;
    if (fits) low = candidate;
    else high = candidate - 1;
  }
  return low;
}

export function validatePluginRpcMethod(message, limits) {
  if (message.method === 'document.getMetadata') {
    assertExactFields(message.params, ['handle'], 'document.getMetadata params');
  } else if (message.method === 'document.readRange') {
    assertExactFields(message.params, ['handle', 'length', 'offset'], 'document.readRange params');
    if (!Number.isSafeInteger(message.params.offset) || message.params.offset < 0
      || !Number.isSafeInteger(message.params.length) || message.params.length < 1) {
      fail('PLUGIN_RPC_INVALID_PARAMS', 'Document range parameters are invalid.');
    }
    if (message.params.length > maxRpcReadRangeBytes(message, limits)) {
      fail('PLUGIN_RPC_RESULT_BUDGET', 'The requested document range cannot fit in one bounded RPC result.', 413);
    }
  } else {
    fail('PLUGIN_RPC_METHOD_UNKNOWN', 'The requested plugin method is not brokered.', 404);
  }
  if (!HANDLE.test(message.params.handle)) fail('PLUGIN_RPC_INVALID_PARAMS', 'The document handle is invalid.');
}

export function dispatchPluginRpcMethod(message, handles, context) {
  return message.method === 'document.getMetadata'
    ? handles.getMetadata(message.params.handle, context)
    : handles.readRange(message.params.handle, {
      offset: message.params.offset, length: message.params.length,
    }, context).then((bytes) => ({ encoding: 'base64', byteLength: bytes.length, data: bytes.toString('base64') }));
}

export function successPluginRpcResult(message, value) {
  return boundResult(message, value);
}

export function errorPluginRpcResult(message, error) {
  const exposedCodes = new Set([
    'PLUGIN_GRANT_EXPIRED', 'PLUGIN_GRANT_REVOKED', 'PLUGIN_GRANT_CONSUMED',
    'PLUGIN_HANDLE_EXPIRED', 'PLUGIN_HANDLE_REVOKED', 'PLUGIN_HANDLE_CONSUMED',
    'PLUGIN_HANDLE_BYTE_QUOTA', 'PLUGIN_HANDLE_METHOD_DENIED', 'PLUGIN_RANGE_INVALID',
    'PLUGIN_REQUEST_CANCELLED', 'PLUGIN_REQUEST_TIMEOUT',
  ]);
  const code = exposedCodes.has(error?.code) ? error.code : 'PLUGIN_REQUEST_FAILED';
  return {
    protocol: PLUGIN_RPC_PROTOCOL,
    nonce: message.nonce,
    pluginId: message.pluginId,
    version: message.version,
    packageHash: message.packageHash,
    activationId: message.activationId,
    type: 'error',
    id: message.id,
    sequence: message.sequence,
    error: { code, message: 'The local plugin request was denied or could not be completed.' },
  };
}
