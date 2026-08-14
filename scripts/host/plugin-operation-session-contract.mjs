import { randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { HostError } from './host-error.mjs';
import { PACKAGE_LIMITS } from './plugin-package-contract.mjs';

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
const LAUNCH_DESCRIPTOR_FIELDS = new Set(['id', 'version', 'digest', 'packageHash', 'manifest', 'publisher', 'packageRoot', 'entryPath', 'inventory', 'dependencies', 'executableRuntime']);
const EXECUTABLE_RUNTIME_FIELDS = new Set(['kind', 'apiVersion', 'entry', 'sha256']);

function fail(code, message, status = 500) { throw new HostError(code, message, status); }
function assertAuthority(value, methods, label) { if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${label} does not implement the required host authority.`); }
function opaqueId(prefix, randomBytesImpl) {
  const bytes = randomBytesImpl(24);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('randomBytesImpl must return bytes.');
  if (bytes.byteLength !== 24) throw new TypeError('randomBytesImpl returned the wrong byte count.');
  return `${prefix}_${Buffer.from(bytes).toString('base64url')}`;
}

export function assertOperationInputs({ packages, grants, handles, pluginId, documentId, permissions, methods, randomBytesImpl, audit, signal }) {
  assertAuthority(packages, ['getLaunchDescriptor'], 'Plugin package store');
  assertAuthority(grants, ['issue', 'revokeActivation'], 'Plugin grant store');
  assertAuthority(handles, ['issue', 'getMetadata', 'readRange', 'revokeActivation'], 'Plugin document handle store');
  if (!PLUGIN_ID.test(String(pluginId ?? ''))) throw new TypeError('pluginId is invalid.');
  if (typeof documentId !== 'string' || !documentId) throw new TypeError('documentId is required.');
  if (!Array.isArray(permissions) || permissions.length === 0 || !Array.isArray(methods) || methods.length === 0) throw new TypeError('permissions and methods must be non-empty arrays.');
  if (typeof randomBytesImpl !== 'function' || typeof audit !== 'function') throw new TypeError('randomBytesImpl and audit must be callable.');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
}

export function assertPluginOperationNotCancelled(signal) {
  if (signal?.aborted) fail('PLUGIN_WORKER_CANCELLED', 'The plugin operation was cancelled.', 499);
}

export async function getLaunchDescriptor(packages, pluginId) { return validatePluginLaunchDescriptor(await packages.getLaunchDescriptor(pluginId), pluginId); }

export function validatePluginLaunchDescriptor(value, pluginId) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  const invalid = !value || typeof value !== 'object' || Array.isArray(value)
    || keys.length !== LAUNCH_DESCRIPTOR_FIELDS.size || keys.some((key) => !LAUNCH_DESCRIPTOR_FIELDS.has(key))
    || value.id !== pluginId || !PLUGIN_ID.test(value.id) || !SEMVER.test(value.version ?? '')
    || !SHA256.test(value.digest ?? '') || value.packageHash !== value.digest || !value.manifest
    || value.manifest.manifestVersion !== 3 || value.manifest.id !== value.id || value.manifest.version !== value.version
    || !value.manifest.runtime || value.manifest.runtime.kind !== 'javascriptcore-classic-script'
    || value.manifest.runtime.apiVersion !== 1 || !value.executableRuntime
    || Object.keys(value.executableRuntime).length !== EXECUTABLE_RUNTIME_FIELDS.size
    || Object.keys(value.executableRuntime).some((key) => !EXECUTABLE_RUNTIME_FIELDS.has(key))
    || value.executableRuntime.kind !== value.manifest.runtime.kind
    || value.executableRuntime.apiVersion !== value.manifest.runtime.apiVersion
    || value.executableRuntime.entry !== value.manifest.entry
    || !SHA256.test(value.executableRuntime.sha256 ?? '')
    || !Array.isArray(value.manifest.capabilities) || value.manifest.capabilities.length === 0
    || value.manifest.capabilities.length > 64 || new Set(value.manifest.capabilities).size !== value.manifest.capabilities.length
    || value.manifest.capabilities.some((capability) => !CAPABILITY_ID.test(capability))
    || !Array.isArray(value.manifest.dependencies) || !Array.isArray(value.dependencies)
    || typeof value.entryPath !== 'string' || !isAbsolute(value.entryPath)
    || typeof value.packageRoot !== 'string' || !isAbsolute(value.packageRoot) || !Array.isArray(value.inventory);
  if (invalid) fail('PLUGIN_LAUNCH_DESCRIPTOR_INVALID', 'The active signed package did not produce a valid launch descriptor.');
  if (value.manifest.dependencies.length !== 0 || value.dependencies.length !== 0) fail('PLUGIN_RUNTIME_DEPENDENCIES_DISABLED', 'Executable plugin dependencies are disabled for the one-shot runtime.', 409);
  const entryRelative = relative(value.packageRoot, value.entryPath);
  if (!entryRelative || entryRelative === '..' || entryRelative.startsWith(`..${sep}`) || value.entryPath !== join(value.packageRoot, value.manifest.entry) || value.inventory.length < 1 || value.inventory.length > PACKAGE_LIMITS.maxFiles) fail('PLUGIN_LAUNCH_DESCRIPTOR_INVALID', 'The active signed package did not produce a valid launch descriptor.');
  let totalBytes = 0; const inventoryPaths = new Set();
  for (const file of value.inventory) {
    const fileKeys = file && typeof file === 'object' && !Array.isArray(file) ? Object.keys(file) : [];
    if (fileKeys.length !== 4 || !['path', 'mediaType', 'size', 'sha256'].every((key) => fileKeys.includes(key)) || typeof file.path !== 'string' || typeof file.mediaType !== 'string' || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > PACKAGE_LIMITS.maxFileBytes || !SHA256.test(file.sha256) || inventoryPaths.has(file.path)) fail('PLUGIN_LAUNCH_DESCRIPTOR_INVALID', 'The active signed package did not produce a valid launch descriptor.');
    inventoryPaths.add(file.path); totalBytes += file.size;
  }
  const entry = value.inventory.find((file) => file.path === value.manifest.entry);
  if (totalBytes > PACKAGE_LIMITS.maxTotalBytes || !entry
    || entry.sha256 !== value.executableRuntime.sha256) fail('PLUGIN_LAUNCH_DESCRIPTOR_INVALID', 'The active signed package did not produce a valid launch descriptor.');
  return Object.freeze({ id: value.id, version: value.version, digest: value.digest, packageHash: value.packageHash, manifest: value.manifest, publisher: value.publisher, packageRoot: value.packageRoot, entryPath: value.entryPath, inventory: Object.freeze(value.inventory.map((file) => Object.freeze({ ...file }))), dependencies: Object.freeze([]), executableRuntime: Object.freeze({ ...value.executableRuntime }) });
}

export function makeOperationBinding(launchDescriptor, pluginId, randomBytesImpl = randomBytes) {
  const activationId = opaqueId('activation', randomBytesImpl); const operationId = opaqueId('operation', randomBytesImpl); const nonceBytes = randomBytesImpl(32);
  if ((!Buffer.isBuffer(nonceBytes) && !(nonceBytes instanceof Uint8Array)) || nonceBytes.byteLength !== 32) throw new TypeError('randomBytesImpl returned the wrong byte count.');
  const binding = Object.freeze({ pluginId, version: launchDescriptor.version, packageHash: launchDescriptor.digest, activationId });
  return { activationId, operationId, binding, rpcBinding: Object.freeze({ ...binding, operationId, nonce: Buffer.from(nonceBytes).toString('hex') }) };
}
