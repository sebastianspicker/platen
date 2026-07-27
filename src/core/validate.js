import { PlatenError } from './errors.js';
import { validatePermissionRequest } from './permissions.js';

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
const MANIFEST_FIELDS = new Set([
  'manifestVersion', 'id', 'name', 'version', 'protocolVersion', 'entry',
  'capabilities', 'permissions', 'dependencies', 'activation',
]);
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

function invalid(message) {
  throw new PlatenError('MANIFEST_INVALID', message);
}

function assertUnique(values, label, key = (value) => value) {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length) invalid(`${label} must not contain duplicates.`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateEntry(entry) {
  if (typeof entry !== 'string' || !entry || entry.length > 160 || !/^[\x20-\x7e]+$/.test(entry)
    || entry.includes('%') || entry.includes('\\') || entry.startsWith('/') || entry.includes('//')) {
    invalid('Plugin entry must stay inside its package and end in .mjs.');
  }
  const parts = entry.split('/');
  if (parts.length > 6 || parts.some((part) => !SAFE_PATH_SEGMENT.test(part) || part === '.' || part === '..') || !entry.endsWith('.mjs')) {
    invalid('Plugin entry must stay inside its package and end in .mjs.');
  }
}

export function validateRuntimeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) invalid('Manifest must be an object.');
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(key)) invalid(`Unknown manifest field: ${key}.`);
  }
  for (const key of MANIFEST_FIELDS) {
    if (!Object.hasOwn(manifest, key)) invalid(`Missing manifest field: ${key}.`);
  }
  if (manifest.manifestVersion !== 2 || manifest.protocolVersion !== 1) invalid('Only process-worker manifest version 2 and protocol version 1 are supported.');
  if (!PLUGIN_ID.test(manifest.id)) invalid('Plugin ID must be a reverse-domain identifier.');
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) invalid('Plugin name is required.');
  if (!SEMVER.test(manifest.version)) invalid('Plugin version must be an exact semantic version.');
  validateEntry(manifest.entry);
  if (!['manual', 'on-capability'].includes(manifest.activation)) invalid('Unknown activation mode.');

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) invalid('A plugin must declare capabilities.');
  assertUnique(manifest.capabilities, 'Capabilities');
  if (manifest.capabilities.some((id) => typeof id !== 'string' || !CAPABILITY_ID.test(id))) invalid('Capability IDs are invalid.');

  if (!Array.isArray(manifest.permissions)) invalid('Permissions must be an array.');
  assertUnique(manifest.permissions, 'Permissions', (permission) => permission?.name);
  manifest.permissions.forEach(validatePermissionRequest);

  if (!Array.isArray(manifest.dependencies)) invalid('Dependencies must be an array.');
  assertUnique(manifest.dependencies, 'Dependencies', (dependency) => dependency?.id);
  for (const dependency of manifest.dependencies) {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) invalid('Dependencies must be objects.');
    if (Object.keys(dependency).sort().join(',') !== 'digest,id,version') invalid('Dependencies require id, version, and signed package digest.');
    if (!PLUGIN_ID.test(dependency.id) || !SEMVER.test(dependency.version) || !SHA256.test(dependency.digest)) invalid('Dependencies need a valid ID, exact version, and SHA-256 package digest.');
    if (dependency.id === manifest.id) invalid('A plugin cannot depend on itself.');
  }
  return deepFreeze(structuredClone(manifest));
}

export { CAPABILITY_ID, PLUGIN_ID, SEMVER, SHA256 };
