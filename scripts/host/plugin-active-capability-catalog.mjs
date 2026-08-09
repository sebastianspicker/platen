import { HostError } from './host-error.mjs';
import {
  CAPABILITY_ID,
  MANIFEST_V2_FIELDS,
  MANIFEST_V3_FIELDS,
  PLUGIN_ID,
  SEMVER,
  SHA256,
} from './plugin-package-contract.mjs';
import { validatePluginLaunchDescriptor } from './plugin-operation-session-contract.mjs';

const CATALOG_SCHEMA_VERSION = 1;
const CATALOG_KIND = 'active-plugin-capability-catalog';
const MAX_PLUGIN_PACKAGES = 64;
const PLUGIN_SUMMARY_FIELDS = Object.freeze(['id', 'activeVersion', 'previousVersion', 'versions']);
const PLUGIN_VERSION_FIELDS = Object.freeze(['version', 'digest']);
const LAUNCH_DESCRIPTOR_FIELDS = Object.freeze([
  'id', 'version', 'digest', 'packageHash', 'manifest', 'publisher', 'packageRoot',
  'entryPath', 'inventory', 'dependencies', 'executableRuntime',
]);
const PUBLISHER_FIELDS = Object.freeze(['publisherId', 'keyId']);

function fail(code, message, status = 500, cause) {
  throw new HostError(code, message, status, cause === undefined ? undefined : { cause });
}

function assertAuthority(authority) {
  if (!authority || typeof authority !== 'object') {
    fail(
      'PLUGIN_ACTIVE_CAPABILITY_CATALOG_AUTHORITY_MISSING',
      'Plugin catalog authority is required.',
      503,
    );
  }
  if (typeof authority.listPlugins !== 'function' || typeof authority.getLaunchDescriptor !== 'function') {
    fail(
      'PLUGIN_ACTIVE_CAPABILITY_CATALOG_AUTHORITY_MISSING',
      'Plugin catalog authority must expose listPlugins() and getLaunchDescriptor().',
      503,
    );
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function dataRecord(value, fields, code, message, { exact = true, status = 500 } = {}) {
  let descriptors;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
      fail(code, message, status);
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if ((exact && keys.length !== fields.length)
      || fields.some((field) => !Object.hasOwn(descriptors, field) || !Object.hasOwn(descriptors[field], 'value'))
      || (exact && keys.some((key) => typeof key !== 'string' || !fields.includes(key)))) {
      fail(code, message, status);
    }
  } catch (error) {
    if (error instanceof HostError) throw error;
    fail(code, message, status, error);
  }
  return Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
}

function dataArray(value, maxLength, code, message, status = 500) {
  let descriptors;
  let keys;
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      fail(code, message, status);
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    if (error instanceof HostError) throw error;
    fail(code, message, status, error);
  }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength
    || keys.length !== length + 1 || keys.some((key) => key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length))) {
    fail(code, message, status);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code, message, status);
    result.push(descriptor.value);
  }
  return result;
}

function normalizeVersions(plugin) {
  const rawVersions = dataArray(
    plugin.versions,
    MAX_PLUGIN_PACKAGES,
    'PLUGIN_ACTIVE_CAPABILITY_CATALOG_PLUGIN_RECORD_INVALID',
    'Plugin registry record has invalid versions.',
  );
  const versions = Object.freeze(rawVersions.map((value) => {
    const version = dataRecord(
      value,
      PLUGIN_VERSION_FIELDS,
      'PLUGIN_ACTIVE_CAPABILITY_CATALOG_PLUGIN_RECORD_INVALID',
      'Plugin registry version record is malformed.',
    );
    if (typeof version.version !== 'string' || !SEMVER.test(version.version)
      || typeof version.digest !== 'string' || !SHA256.test(version.digest)) {
      fail('PLUGIN_ACTIVE_CAPABILITY_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry version record is invalid.', 500);
    }
    return Object.freeze(version);
  }));
  if (plugin.activeVersion === null) return versions;
  const active = versions.find(({ version }) => version === plugin.activeVersion);
  if (!active) {
    fail(
      'PLUGIN_ACTIVE_CAPABILITY_CATALOG_ACTIVE_RECORD_INVALID',
      `The active package state for ${plugin.id} has no matching digest.`,
      409,
    );
  }
  return versions;
}

function normalizePluginEntries(entries) {
  const rawEntries = dataArray(
    entries,
    MAX_PLUGIN_PACKAGES,
    'PLUGIN_ACTIVE_CAPABILITY_CATALOG_PLUGIN_RECORD_INVALID',
    'Plugin registry listing is malformed.',
  );
  if (rawEntries.length === 0) return Object.freeze([]);
  const byId = new Map();
  for (const value of rawEntries) {
    const entry = dataRecord(
      value,
      PLUGIN_SUMMARY_FIELDS,
      'PLUGIN_ACTIVE_CAPABILITY_CATALOG_PLUGIN_RECORD_INVALID',
      'Plugin registry record is malformed.',
    );
    if (typeof entry.id !== 'string' || !PLUGIN_ID.test(entry.id)) {
      fail('PLUGIN_ACTIVE_CAPABILITY_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry record has an invalid ID.', 500);
    }
    if (entry.activeVersion !== null && (typeof entry.activeVersion !== 'string' || !SEMVER.test(entry.activeVersion))) {
      fail('PLUGIN_ACTIVE_CAPABILITY_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry record has an invalid active version.', 500);
    }
    if (entry.previousVersion !== null
      && (typeof entry.previousVersion !== 'string' || !SEMVER.test(entry.previousVersion))) {
      fail('PLUGIN_ACTIVE_CAPABILITY_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry record has an invalid previous version.', 500);
    }
    const versions = normalizeVersions(entry);
    if (byId.has(entry.id)) {
      fail('PLUGIN_ACTIVE_CAPABILITY_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry listing contains duplicate IDs.', 409);
    }
    byId.set(entry.id, Object.freeze({
      id: entry.id,
      activeVersion: entry.activeVersion,
      activeDigest: entry.activeVersion === null ? null : versions.find(({ version }) => version === entry.activeVersion).digest,
    }));
  }
  return Object.freeze(Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id, 'en')));
}

function sanitizeCapabilities(capabilities, pluginId) {
  const values = dataArray(
    capabilities,
    64,
    'PLUGIN_ACTIVE_CAPABILITY_CATALOG_CAPABILITY_ID_INVALID',
    'Plugin launch descriptors must expose valid capabilities.',
    502,
  );
  if (values.length === 0) {
    fail(
      'PLUGIN_ACTIVE_CAPABILITY_CATALOG_CAPABILITY_ID_INVALID',
      'Plugin launch descriptors must expose at least one capability.',
      502,
    );
  }
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !CAPABILITY_ID.test(value) || seen.has(value)) {
      fail(
        'PLUGIN_ACTIVE_CAPABILITY_CATALOG_CAPABILITY_ID_INVALID',
        'Plugin launch descriptors must expose valid unique capability identifiers.',
        502,
      );
    }
    seen.add(value);
    normalized.push(value);
  }
  return Object.freeze(normalized.sort((left, right) => left.localeCompare(right, 'en')));
}

function assertDescriptorIdentity(descriptor, pluginId, expectedVersion, expectedDigest) {
  const values = dataRecord(
    descriptor,
    LAUNCH_DESCRIPTOR_FIELDS,
    'PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID',
    'The active plugin launch descriptor is malformed.',
    { status: 502 },
  );
  if (values.id !== pluginId || !PLUGIN_ID.test(values.id ?? '')
    || !SEMVER.test(values.version ?? '') || !SHA256.test(values.digest ?? '')
    || values.packageHash !== values.digest) {
    fail('PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID', 'The active plugin launch descriptor identity is invalid.', 502);
  }
  if (values.version !== expectedVersion || values.digest !== expectedDigest) {
    fail(
      'PLUGIN_ACTIVE_CAPABILITY_CATALOG_DRIFT',
      `Plugin launch descriptor changed during catalog collection for ${pluginId}.`,
      409,
    );
  }
  return values;
}

function metadataOnlyDescriptor(values, pluginId) {
  const version = dataRecord(
    values.manifest,
    ['manifestVersion'],
    'PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID',
    'The active plugin manifest is malformed.',
    { exact: false, status: 502 },
  ).manifestVersion;
  if (version !== 2) return false;
  const manifest = dataRecord(
    values.manifest,
    MANIFEST_V2_FIELDS,
    'PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID',
    'The active metadata-only plugin manifest is malformed.',
    { status: 502 },
  );
  const publisher = dataRecord(
    values.publisher,
    PUBLISHER_FIELDS,
    'PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID',
    'The active plugin publisher is malformed.',
    { status: 502 },
  );
  sanitizeCapabilities(manifest.capabilities, pluginId);
  if (manifest.id !== pluginId || manifest.version !== values.version
    || manifest.protocolVersion !== 1 || typeof manifest.name !== 'string' || !manifest.name.trim()
    || !['manual', 'on-capability'].includes(manifest.activation)
    || !PLUGIN_ID.test(publisher.publisherId ?? '') || typeof publisher.keyId !== 'string'
    || values.executableRuntime !== null) {
    fail('PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID', 'The active metadata-only plugin descriptor is invalid.', 502);
  }
  return true;
}

function sanitizeLaunchDescriptor(descriptor, pluginId, expectedVersion, expectedDigest) {
  const values = assertDescriptorIdentity(descriptor, pluginId, expectedVersion, expectedDigest);
  if (metadataOnlyDescriptor(values, pluginId)) return null;
  const capabilityField = dataRecord(
    values.manifest,
    ['capabilities'],
    'PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID',
    'The active executable plugin capabilities are malformed.',
    { exact: false, status: 502 },
  );
  sanitizeCapabilities(capabilityField.capabilities, pluginId);
  let validated;
  try {
    validated = validatePluginLaunchDescriptor(descriptor, pluginId);
  } catch (error) {
    if (error instanceof HostError) throw error;
    fail(
      'PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID',
      'The active executable plugin launch descriptor is malformed.',
      502,
      error,
    );
  }
  const manifest = dataRecord(
    validated.manifest,
    MANIFEST_V3_FIELDS,
    'PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID',
    'The active executable plugin manifest is malformed.',
    { status: 502 },
  );
  const publisher = dataRecord(
    validated.publisher,
    PUBLISHER_FIELDS,
    'PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID',
    'The active plugin publisher is malformed.',
    { status: 502 },
  );
  const capabilities = sanitizeCapabilities(manifest.capabilities, pluginId);
  if (typeof manifest.name !== 'string' || !manifest.name.trim()
    || !['manual', 'on-capability'].includes(manifest.activation)
    || !PLUGIN_ID.test(publisher.publisherId ?? '') || typeof publisher.keyId !== 'string') {
    fail('PLUGIN_ACTIVE_CAPABILITY_CATALOG_DESCRIPTOR_INVALID', 'The active executable plugin metadata is invalid.', 502);
  }
  return {
    id: validated.id,
    version: validated.version,
    digest: validated.digest,
    name: manifest.name,
    activation: manifest.activation,
    manifestVersion: manifest.manifestVersion,
    protocolVersion: manifest.protocolVersion,
    capabilities,
    publisher: Object.freeze({
      publisherId: publisher.publisherId,
      keyId: publisher.keyId,
    }),
  };
}

function assertNotCancelled(signal) {
  if (signal?.aborted) fail('JOB_CANCELLED', 'Plugin capability catalog collection was cancelled.', 499);
}
function deriveConflicts(packages) {
  const providersByCapability = new Map();
  for (const plugin of packages) {
    for (const capabilityId of plugin.capabilities) {
      const providers = providersByCapability.get(capabilityId) ?? new Set();
      providers.add(plugin.id);
      providersByCapability.set(capabilityId, providers);
    }
  }
  const conflicts = [];
  for (const [capabilityId, providers] of providersByCapability) {
    if (providers.size < 2) continue;
    const providerIds = Array.from(providers).sort((left, right) => left.localeCompare(right, 'en'));
    conflicts.push(Object.freeze({
      capabilityId,
      providerIds: Object.freeze(providerIds),
      selectedProviderId: providerIds[0],
    }));
  }
  conflicts.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId, 'en'));
  return Object.freeze(conflicts);
}

function emptyCatalog() {
  return deepFreeze({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    kind: CATALOG_KIND,
    localOnly: true,
    executablePackagesOnly: true,
    catalogOnlyExecution: true,
    conflictResolution: 'lexicographic-plugin-id',
    conflictCount: 0,
    conflicts: Object.freeze([]),
    count: 0,
    packageIds: Object.freeze([]),
    packages: Object.freeze([]),
  });
}

export async function collectActivePluginCapabilityCatalog(authority, { signal } = {}) {
  assertAuthority(authority);
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('Plugin capability catalog signal must be an AbortSignal.');
  }
  assertNotCancelled(signal);
  const rawEntries = await authority.listPlugins();
  assertNotCancelled(signal);
  const entries = normalizePluginEntries(rawEntries);
  if (entries.length === 0) return emptyCatalog();
  const packages = [];
  for (const { id, activeVersion, activeDigest } of entries) {
    assertNotCancelled(signal);
    if (activeVersion === null || activeDigest === null) continue;
    let launchDescriptor;
    try {
      launchDescriptor = await authority.getLaunchDescriptor(id);
    } catch (error) {
      throw error instanceof HostError
        ? error
        : new HostError('PLUGIN_ACTIVE_CAPABILITY_CATALOG_LAUNCH_DESCRIPTOR_FETCH_FAILED', 'The active plugin launch descriptor could not be read.', 503, { cause: error });
    }
    const descriptor = sanitizeLaunchDescriptor(launchDescriptor, id, activeVersion, activeDigest);
    if (descriptor) packages.push(descriptor);
  }
  assertNotCancelled(signal);
  const packageIds = Object.freeze(packages.map((value) => value.id));
  const conflicts = deriveConflicts(packages);
  return deepFreeze({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    kind: CATALOG_KIND,
    localOnly: true,
    executablePackagesOnly: true,
    catalogOnlyExecution: true,
    conflictResolution: 'lexicographic-plugin-id',
    conflictCount: conflicts.length,
    conflicts,
    count: packages.length,
    packageIds,
    packages: deepFreeze(packages.map(Object.freeze)),
  });
}
