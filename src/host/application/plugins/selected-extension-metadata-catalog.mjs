import { HostError } from '../../platform/runtime/host-error.mjs';
import {
  CAPABILITY_ID,
  MANIFEST_FIELDS,
  PLUGIN_ID,
  SEMVER,
  SHA256,
} from './plugin-package-contract.mjs';

const CATALOG_SCHEMA_VERSION = 1;
const CATALOG_KIND = 'selected-extension-metadata-catalog';
const MAX_PLUGIN_PACKAGES = 64;
const PLUGIN_SUMMARY_FIELDS = Object.freeze(['id', 'selectedVersion', 'previousSelectedVersion', 'versions']);
const PLUGIN_VERSION_FIELDS = Object.freeze(['version', 'digest']);
const SELECTION_FIELDS = Object.freeze(['id', 'version', 'digest', 'manifest', 'publisher']);
const PUBLISHER_FIELDS = Object.freeze(['publisherId', 'keyId']);

function fail(code, message, status = 500, cause) {
  throw new HostError(code, message, status, cause === undefined ? undefined : { cause });
}

function assertAuthority(authority) {
  if (!authority || typeof authority !== 'object'
    || typeof authority.listPlugins !== 'function' || typeof authority.getSelectedPackage !== 'function') {
    fail('PLUGIN_SELECTED_METADATA_CATALOG_AUTHORITY_MISSING', 'Plugin catalog authority must expose listPlugins() and getSelectedPackage().', 503);
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
      || Object.getPrototypeOf(value) !== Object.prototype) fail(code, message, status);
    descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if ((exact && keys.length !== fields.length)
      || fields.some((field) => !Object.hasOwn(descriptors, field) || !Object.hasOwn(descriptors[field], 'value'))
      || (exact && keys.some((key) => typeof key !== 'string' || !fields.includes(key)))) fail(code, message, status);
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
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code, message, status);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    if (error instanceof HostError) throw error;
    fail(code, message, status, error);
  }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength
    || keys.length !== length + 1 || keys.some((key) => key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length))) fail(code, message, status);
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code, message, status);
    result.push(descriptor.value);
  }
  return result;
}

function normalizeVersions(plugin) {
  const rawVersions = dataArray(plugin.versions, MAX_PLUGIN_PACKAGES,
    'PLUGIN_SELECTED_METADATA_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry record has invalid versions.');
  const versions = Object.freeze(rawVersions.map((value) => {
    const version = dataRecord(value, PLUGIN_VERSION_FIELDS,
      'PLUGIN_SELECTED_METADATA_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry version record is malformed.');
    if (typeof version.version !== 'string' || !SEMVER.test(version.version)
      || typeof version.digest !== 'string' || !SHA256.test(version.digest)) {
      fail('PLUGIN_SELECTED_METADATA_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry version record is invalid.', 500);
    }
    return Object.freeze(version);
  }));
  if (plugin.selectedVersion === null) return versions;
  const selected = versions.find(({ version }) => version === plugin.selectedVersion);
  if (!selected) fail('PLUGIN_SELECTED_METADATA_CATALOG_SELECTION_RECORD_INVALID', `The selected package state for ${plugin.id} has no matching digest.`, 409);
  return versions;
}

function normalizePluginEntries(entries) {
  const rawEntries = dataArray(entries, MAX_PLUGIN_PACKAGES,
    'PLUGIN_SELECTED_METADATA_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry listing is malformed.');
  const byId = new Map();
  for (const value of rawEntries) {
    const entry = dataRecord(value, PLUGIN_SUMMARY_FIELDS,
      'PLUGIN_SELECTED_METADATA_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry record is malformed.');
    if (typeof entry.id !== 'string' || !PLUGIN_ID.test(entry.id)
      || (entry.selectedVersion !== null && (typeof entry.selectedVersion !== 'string' || !SEMVER.test(entry.selectedVersion)))
      || (entry.previousSelectedVersion !== null && (typeof entry.previousSelectedVersion !== 'string' || !SEMVER.test(entry.previousSelectedVersion)))) {
      fail('PLUGIN_SELECTED_METADATA_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry record is invalid.', 500);
    }
    const versions = normalizeVersions(entry);
    if (byId.has(entry.id)) fail('PLUGIN_SELECTED_METADATA_CATALOG_PLUGIN_RECORD_INVALID', 'Plugin registry listing contains duplicate IDs.', 409);
    byId.set(entry.id, Object.freeze({
      id: entry.id,
      selectedVersion: entry.selectedVersion,
      selectedDigest: entry.selectedVersion === null ? null : versions.find(({ version }) => version === entry.selectedVersion).digest,
    }));
  }
  return Object.freeze(Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id, 'en')));
}

function sanitizeCapabilities(capabilities) {
  const values = dataArray(capabilities, 64,
    'PLUGIN_SELECTED_METADATA_CATALOG_CAPABILITY_ID_INVALID', 'Plugin manifests must expose valid capabilities.', 502);
  if (values.length === 0) fail('PLUGIN_SELECTED_METADATA_CATALOG_CAPABILITY_ID_INVALID', 'Plugin manifests must expose at least one capability.', 502);
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !CAPABILITY_ID.test(value) || seen.has(value)) {
      fail('PLUGIN_SELECTED_METADATA_CATALOG_CAPABILITY_ID_INVALID', 'Plugin manifests must expose valid unique capability identifiers.', 502);
    }
    seen.add(value);
  }
  return Object.freeze([...seen].sort((left, right) => left.localeCompare(right, 'en')));
}

function sanitizeSelectedPackage(selection, pluginId, expectedVersion, expectedDigest) {
  const values = dataRecord(selection, SELECTION_FIELDS,
    'PLUGIN_SELECTED_METADATA_CATALOG_DESCRIPTOR_INVALID', 'The selected plugin package record is malformed.', { status: 502 });
  if (values.id !== pluginId || values.version !== expectedVersion || values.digest !== expectedDigest
    || !PLUGIN_ID.test(values.id ?? '') || !SEMVER.test(values.version ?? '') || !SHA256.test(values.digest ?? '')) {
    fail('PLUGIN_SELECTED_METADATA_CATALOG_DRIFT', `Selected package state changed during catalog collection for ${pluginId}.`, 409);
  }
  const manifest = dataRecord(values.manifest, MANIFEST_FIELDS,
    'PLUGIN_SELECTED_METADATA_CATALOG_DESCRIPTOR_INVALID', 'The selected plugin manifest is malformed.', { status: 502 });
  const publisher = dataRecord(values.publisher, PUBLISHER_FIELDS,
    'PLUGIN_SELECTED_METADATA_CATALOG_DESCRIPTOR_INVALID', 'The selected plugin publisher is malformed.', { status: 502 });
  if (manifest.manifestVersion !== 1 || manifest.id !== values.id || manifest.version !== values.version
    || typeof manifest.name !== 'string' || !manifest.name.trim()
    || typeof manifest.description !== 'string' || !manifest.description.trim()
    || !PLUGIN_ID.test(publisher.publisherId ?? '') || typeof publisher.keyId !== 'string') {
    fail('PLUGIN_SELECTED_METADATA_CATALOG_DESCRIPTOR_INVALID', 'The selected plugin package record is invalid.', 502);
  }
  return Object.freeze({
    id: values.id,
    version: values.version,
    digest: values.digest,
    name: manifest.name,
    description: manifest.description,
    manifestVersion: manifest.manifestVersion,
    capabilities: sanitizeCapabilities(manifest.capabilities),
    publisher: Object.freeze({ publisherId: publisher.publisherId, keyId: publisher.keyId }),
  });
}

function assertNotCancelled(signal) {
  if (signal?.aborted) fail('JOB_CANCELLED', 'Plugin metadata catalog collection was cancelled.', 499);
}

function deriveDuplicateDeclarations(packages) {
  const packageIdsByCapability = new Map();
  for (const plugin of packages) for (const capabilityId of plugin.capabilities) {
    const packageIds = packageIdsByCapability.get(capabilityId) ?? new Set();
    packageIds.add(plugin.id);
    packageIdsByCapability.set(capabilityId, packageIds);
  }
  return Object.freeze([...packageIdsByCapability.entries()]
    .filter(([, packageIds]) => packageIds.size > 1)
    .map(([capabilityId, packageIds]) => {
      const sortedPackageIds = Object.freeze([...packageIds].sort((left, right) => left.localeCompare(right, 'en')));
      return Object.freeze({ capabilityId, packageIds: sortedPackageIds });
    })
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId, 'en')));
}

function catalog(packages) {
  const duplicateDeclarations = deriveDuplicateDeclarations(packages);
  return deepFreeze({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    kind: CATALOG_KIND,
    localOnly: true,
    metadataOnly: true,
    duplicateDeclarationCount: duplicateDeclarations.length,
    duplicateDeclarations,
    count: packages.length,
    packageIds: Object.freeze(packages.map((value) => value.id)),
    packages: deepFreeze(packages.map(Object.freeze)),
  });
}

export async function collectSelectedExtensionMetadataCatalog(authority, { signal } = {}) {
  assertAuthority(authority);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Plugin capability catalog signal must be an AbortSignal.');
  assertNotCancelled(signal);
  const entries = normalizePluginEntries(await authority.listPlugins());
  assertNotCancelled(signal);
  const packages = [];
  for (const { id, selectedVersion, selectedDigest } of entries) {
    if (selectedVersion === null || selectedDigest === null) continue;
    assertNotCancelled(signal);
    let selection;
    try {
      selection = await authority.getSelectedPackage(id);
    } catch (error) {
      throw error instanceof HostError ? error
        : new HostError('PLUGIN_SELECTED_METADATA_CATALOG_SELECTION_FETCH_FAILED', 'The selected plugin package could not be read.', 503, { cause: error });
    }
    packages.push(sanitizeSelectedPackage(selection, id, selectedVersion, selectedDigest));
  }
  assertNotCancelled(signal);
  return catalog(packages);
}
