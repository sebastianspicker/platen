import { HostError } from './host-error.mjs';

export const PACKAGE_LIMITS = Object.freeze({
  maxEncodedBytes: 12 * 1024 * 1024,
  maxFiles: 64,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPathLength: 160,
  maxPathDepth: 6,
});

export const PACKAGE_FIELDS = Object.freeze(['packageVersion', 'manifest', 'files', 'signature']);
export const SIGNATURE_FIELDS = Object.freeze(['algorithm', 'publisherId', 'keyId', 'value']);
export const FILE_FIELDS = Object.freeze(['path', 'mediaType', 'size', 'sha256', 'content']);
export const MANIFEST_V2_FIELDS = Object.freeze([
  'manifestVersion', 'id', 'name', 'version', 'protocolVersion', 'entry',
  'capabilities', 'permissions', 'dependencies', 'activation',
]);
export const MANIFEST_V3_FIELDS = Object.freeze([...MANIFEST_V2_FIELDS, 'runtime']);
export const RUNTIME_FIELDS = Object.freeze(['kind', 'apiVersion']);
export const JAVASCRIPTCORE_CLASSIC_RUNTIME = Object.freeze({
  kind: 'javascriptcore-classic-script',
  apiVersion: 1,
});
export const PLUGIN_ID = Object.freeze(/^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/);
export const SEMVER = Object.freeze(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const CAPABILITY_ID = Object.freeze(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/);
export const SAFE_PATH_SEGMENT = Object.freeze(/^[A-Za-z0-9._-]+$/);
export const SAFE_MEDIA_TYPE = Object.freeze(/^[a-z]+\/[a-z0-9.+-]+$/);
export const JAVASCRIPT_MEDIA_TYPES = Object.freeze(['application/javascript', 'text/javascript']);
export const SHA256 = Object.freeze(/^[a-f0-9]{64}$/);
export const BASE64 = Object.freeze(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
);
export const LOCAL_PERMISSIONS = Object.freeze([
  'document.metadata', 'document.read.bytes', 'document.modify', 'document.export',
  'ui.panel', 'ui.toolbar', 'storage.local',
]);
export const RESERVED_PACKAGE_PATHS = Object.freeze(['package.json']);
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
