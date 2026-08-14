/** Shared helpers for professional-capability family handlers. */

export function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  // Buffers / TypedArrays cannot be frozen element-wise.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value);
  }
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export function fail(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function throwFail(code, message, status = 400) {
  throw fail(code, message, status);
}

export function requirePlainObject(value, label = 'request') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throwFail('INVALID_CAPABILITY_REQUEST', `${label} must be a plain object.`);
  }
  return value;
}

export function requireString(value, label, { min = 1, max = 1_000_000 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throwFail('INVALID_CAPABILITY_REQUEST', `${label} must be a string of length ${min}–${max}.`);
  }
  return value;
}

export function requireText(value, label = 'text', max = 2_000_000) {
  return requireString(value, label, { min: 1, max });
}

export function capabilityResult(capabilityId, payload, { limitations = [], localOnly = true } = {}) {
  return freezeDeep({
    schemaVersion: 1,
    capabilityId,
    delivery: 'implemented',
    localOnly,
    at: new Date().toISOString(),
    result: payload,
    limitations: Object.freeze([...limitations]),
  });
}

export const LOCAL_ONLY_LIMITATION = 'Local-only professional delivery; no external network or remote provider calls.';
