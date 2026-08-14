const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PACKAGE_BYTES = 12 * 1024 * 1024;
const CAPABILITY_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/u;

function exact(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function optionsValid(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  return exact(options, options.signal === undefined ? [] : ['signal'])
    && (options.signal === undefined || options.signal instanceof AbortSignal);
}

function pluginSummary(value) {
  if (!exact(value, ['id', 'activeVersion', 'previousVersion', 'versions'])
    || !PLUGIN_ID.test(value.id)
    || (value.activeVersion !== null && !SEMVER.test(value.activeVersion))
    || (value.previousVersion !== null && !SEMVER.test(value.previousVersion))
    || !Array.isArray(value.versions) || value.versions.length > 64) return false;
  return value.versions.every((entry) => exact(entry, ['version', 'digest'])
    && SEMVER.test(entry.version) && SHA256.test(entry.digest));
}

function lifecycle(body, action) {
  if (!exact(body, ['action', 'result', 'localOnly']) || body.action !== action
    || body.localOnly !== true) throw new TypeError('Plugin package lifecycle response is invalid.');
  if (action === 'install') {
    if (!exact(body.result, ['id', 'version', 'digest']) || !PLUGIN_ID.test(body.result.id)
      || !SEMVER.test(body.result.version) || !SHA256.test(body.result.digest)) {
      throw new TypeError('Plugin package lifecycle response is invalid.');
    }
  } else if (!exact(body.result, ['id', 'activeVersion', 'previousVersion', 'versions'])
    || !pluginSummary(body.result)) {
    throw new TypeError('Plugin package lifecycle response is invalid.');
  }
  return Object.freeze(body.result);
}

function list(body) {
  if (!exact(body, ['plugins']) || !Array.isArray(body.plugins) || body.plugins.length > 64
    || body.plugins.some((plugin) => !pluginSummary(plugin))) {
    throw new TypeError('Plugin package listing response is invalid.');
  }
  return Object.freeze(body.plugins);
}

function capabilityCatalogPackage(value) {
  if (!exact(value, ['id', 'version', 'digest', 'name', 'activation', 'manifestVersion', 'protocolVersion', 'capabilities', 'publisher'])
    || !PLUGIN_ID.test(value.id) || !SEMVER.test(value.version) || !SHA256.test(value.digest)
    || typeof value.name !== 'string' || !value.name.trim()
    || !['manual', 'on-capability'].includes(value.activation)
    || value.manifestVersion !== 3 || value.protocolVersion !== 1
    || !Array.isArray(value.capabilities) || value.capabilities.length < 1
    || value.capabilities.length > 64
    || value.capabilities.some((capability) => typeof capability !== 'string' || !CAPABILITY_ID.test(capability))
    || new Set(value.capabilities).size !== value.capabilities.length
    || !exact(value.publisher, ['publisherId', 'keyId'])
    || !PLUGIN_ID.test(value.publisher.publisherId)
    || typeof value.publisher.keyId !== 'string') return null;
  return Object.freeze({
    id: value.id,
    version: value.version,
    digest: value.digest,
    name: value.name,
    activation: value.activation,
    manifestVersion: value.manifestVersion,
    protocolVersion: value.protocolVersion,
    capabilities: Object.freeze([...value.capabilities]),
    publisher: Object.freeze({ ...value.publisher }),
  });
}

function capabilityCatalog(body) {
  const fields = [
    'schemaVersion', 'kind', 'localOnly', 'executablePackagesOnly', 'catalogOnlyExecution',
    'count', 'packageIds', 'packages', 'conflictResolution', 'conflictCount', 'conflicts',
  ];
  if (!exact(body, fields) || body.schemaVersion !== 1
    || body.kind !== 'active-plugin-capability-catalog' || body.localOnly !== true
    || body.executablePackagesOnly !== true || body.catalogOnlyExecution !== true
    || body.conflictResolution !== 'lexicographic-plugin-id'
    || !Number.isSafeInteger(body.count) || body.count < 0 || body.count > 64
    || !Number.isSafeInteger(body.conflictCount) || body.conflictCount < 0
    || !Array.isArray(body.packageIds) || !Array.isArray(body.packages)
    || !Array.isArray(body.conflicts)
    || body.packageIds.length !== body.count || body.packages.length !== body.count
    || body.conflicts.length !== body.conflictCount) {
    throw new TypeError('Plugin capability catalog response is invalid.');
  }
  const packages = body.packages.map(capabilityCatalogPackage);
  const packageIds = [...body.packageIds];
  if (packages.some((value) => value === null)
    || packageIds.some((id) => typeof id !== 'string' || !PLUGIN_ID.test(id))
    || packageIds.some((id, index) => id !== packages[index].id)
    || packageIds.some((id, index) => index > 0 && packageIds[index - 1].localeCompare(id, 'en') >= 0)) {
    throw new TypeError('Plugin capability catalog response is invalid.');
  }

  const providersByCapability = new Map();
  for (const packageValue of packages) {
    for (const capabilityId of packageValue.capabilities) {
      const providers = providersByCapability.get(capabilityId) ?? [];
      providers.push(packageValue.id);
      providersByCapability.set(capabilityId, providers);
    }
  }
  const expectedConflicts = [...providersByCapability.entries()]
    .filter(([, providerIds]) => providerIds.length >= 2)
    .map(([capabilityId, providerIds]) => {
      const sortedProviderIds = [...providerIds].sort((left, right) => left.localeCompare(right, 'en'));
      return { capabilityId, providerIds: sortedProviderIds, selectedProviderId: sortedProviderIds[0] };
    })
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId, 'en'));
  if (body.conflictCount !== expectedConflicts.length
    || body.conflicts.some((conflict, index) => {
      if (!exact(conflict, ['capabilityId', 'providerIds', 'selectedProviderId'])
        || !CAPABILITY_ID.test(conflict.capabilityId)
        || !Array.isArray(conflict.providerIds) || conflict.providerIds.length < 2
        || conflict.providerIds.length > 64
        || conflict.providerIds.some((id) => typeof id !== 'string' || !PLUGIN_ID.test(id)
          || !packageIds.includes(id))
        || new Set(conflict.providerIds).size !== conflict.providerIds.length
        || conflict.providerIds.some((id, providerIndex) => providerIndex > 0
          && conflict.providerIds[providerIndex - 1].localeCompare(id, 'en') >= 0)
        || conflict.selectedProviderId !== conflict.providerIds[0]
        || index > 0
          && body.conflicts[index - 1].capabilityId.localeCompare(conflict.capabilityId, 'en') >= 0) {
        return true;
      }
      const expected = expectedConflicts[index];
      return !expected || expected.capabilityId !== conflict.capabilityId
        || expected.selectedProviderId !== conflict.selectedProviderId
        || expected.providerIds.length !== conflict.providerIds.length
        || expected.providerIds.some((id, providerIndex) => id !== conflict.providerIds[providerIndex]);
    })) {
    throw new TypeError('Plugin capability catalog response is invalid.');
  }
  const conflicts = Object.freeze(body.conflicts.map((conflict) => Object.freeze({
    capabilityId: conflict.capabilityId,
    providerIds: Object.freeze([...conflict.providerIds]),
    selectedProviderId: conflict.selectedProviderId,
  })));
  return Object.freeze({
    schemaVersion: 1,
    kind: 'active-plugin-capability-catalog',
    localOnly: true,
    executablePackagesOnly: true,
    catalogOnlyExecution: true,
    count: body.count,
    packageIds: Object.freeze(packageIds),
    packages: Object.freeze(packages),
    conflictResolution: 'lexicographic-plugin-id',
    conflictCount: body.conflictCount,
    conflicts,
  });
}

export function createPluginPackageEndpoints({ request }) {
  if (typeof request !== 'function') throw new TypeError('Plugin package endpoints require request transport.');
  return Object.freeze({
    listActivePluginCapabilities(options = {}) {
      if (!optionsValid(options)) throw new TypeError('Plugin package options are invalid.');
      return request('/api/plugin-capability-catalog', { method: 'GET', signal: options.signal })
        .then((response) => response.json()).then(capabilityCatalog);
    },
    listPluginPackages(options = {}) {
      if (!optionsValid(options)) throw new TypeError('Plugin package options are invalid.');
      return request('/api/plugin-packages', { method: 'GET', signal: options.signal })
        .then((response) => response.json()).then(list);
    },
    installPluginPackage(bytes, options = {}) {
      if (!optionsValid(options) || (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer))
        || bytes.byteLength < 1 || bytes.byteLength > MAX_PACKAGE_BYTES) {
        throw new TypeError('Plugin package input is invalid.');
      }
      return request('/api/plugin-packages/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        signal: options.signal,
      }).then((response) => response.json()).then((body) => lifecycle(body, 'install'));
    },
    activatePluginPackage(id, version, options = {}) {
      if (!PLUGIN_ID.test(id ?? '') || !SEMVER.test(version ?? '') || !optionsValid(options)) {
        throw new TypeError('Plugin activation options are invalid.');
      }
      return request(`/api/plugin-packages/${encodeURIComponent(id)}/activate?version=${encodeURIComponent(version)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: options.signal,
      }).then((response) => response.json()).then((body) => lifecycle(body, 'activate'));
    },
    rollbackPluginPackage(id, options = {}) {
      if (!PLUGIN_ID.test(id ?? '') || !optionsValid(options)) throw new TypeError('Plugin rollback options are invalid.');
      return request(`/api/plugin-packages/${encodeURIComponent(id)}/rollback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: options.signal,
      }).then((response) => response.json()).then((body) => lifecycle(body, 'rollback'));
    },
  });
}

export { capabilityCatalog, pluginSummary };
