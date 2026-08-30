import { HostError } from '../../platform/runtime/host-error.mjs';

export const PACKAGE_LIMITS = Object.freeze({
  maxEncodedBytes: 256 * 1024,
});

export const PACKAGE_FIELDS = Object.freeze(['packageVersion', 'manifest', 'signature']);
export const SIGNATURE_FIELDS = Object.freeze(['algorithm', 'publisherId', 'keyId', 'value']);
export const MANIFEST_FIELDS = Object.freeze([
  'manifestVersion', 'id', 'name', 'version', 'description', 'capabilities',
]);
export const PLUGIN_ID = Object.freeze(/^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/);
export const SEMVER = Object.freeze(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const CAPABILITY_ID = Object.freeze(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/);
export const SHA256 = Object.freeze(/^[a-f0-9]{64}$/);
export const BASE64 = Object.freeze(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
);
export const TRUST_STATE_FIELDS = Object.freeze(['schemaVersion', 'publishers']);
export const TRUST_PUBLISHER_FIELDS = Object.freeze([
  'publisherId', 'keyId', 'publicKey', 'fingerprint', 'revoked', 'pluginIds',
]);

export function packageFailure(code, message, status = 400) {
  throw new HostError(code, message, status);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function assertExactKeys(value, keys, label) {
  if (!isPlainObject(value)) packageFailure('PACKAGE_INVALID', `${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) packageFailure('PACKAGE_INVALID', `${label} contains unknown field ${key}.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) packageFailure('PACKAGE_INVALID', `${label} is missing field ${key}.`);
  }
}
