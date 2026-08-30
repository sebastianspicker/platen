const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PACKAGE_BYTES = 256 * 1024;
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
  if (!exact(value, ['id', 'selectedVersion', 'previousSelectedVersion', 'versions'])
    || !PLUGIN_ID.test(value.id)
    || (value.selectedVersion !== null && !SEMVER.test(value.selectedVersion))
    || (value.previousSelectedVersion !== null && !SEMVER.test(value.previousSelectedVersion))
    || !Array.isArray(value.versions) || value.versions.length > 64) return false;
  return value.versions.every((entry) => exact(entry, ['version', 'digest'])
    && SEMVER.test(entry.version) && SHA256.test(entry.digest));
}

function selectionResult(body, action) {
  if (!exact(body, ['action', 'result', 'localOnly']) || body.action !== action
    || body.localOnly !== true) throw new TypeError('Plugin package selection response is invalid.');
  if (action === 'install') {
    if (!exact(body.result, ['id', 'version', 'digest']) || !PLUGIN_ID.test(body.result.id)
      || !SEMVER.test(body.result.version) || !SHA256.test(body.result.digest)) {
      throw new TypeError('Plugin package selection response is invalid.');
    }
  } else if (!exact(body.result, ['id', 'selectedVersion', 'previousSelectedVersion', 'versions'])
    || !pluginSummary(body.result)) {
    throw new TypeError('Plugin package selection response is invalid.');
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
  if (!exact(value, ['id', 'version', 'digest', 'name', 'description', 'manifestVersion', 'capabilities', 'publisher'])
    || !PLUGIN_ID.test(value.id) || !SEMVER.test(value.version) || !SHA256.test(value.digest)
    || typeof value.name !== 'string' || !value.name.trim()
    || typeof value.description !== 'string' || !value.description.trim()
    || value.manifestVersion !== 1
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
    description: value.description,
    manifestVersion: value.manifestVersion,
    capabilities: Object.freeze([...value.capabilities]),
    publisher: Object.freeze({ ...value.publisher }),
  });
}

function capabilityCatalog(body) {
  const fields = [
    'schemaVersion', 'kind', 'localOnly', 'metadataOnly',
    'count', 'packageIds', 'packages', 'duplicateDeclarationCount', 'duplicateDeclarations',
  ];
  if (!exact(body, fields) || body.schemaVersion !== 1
    || body.kind !== 'selected-extension-metadata-catalog' || body.localOnly !== true
    || body.metadataOnly !== true
    || !Number.isSafeInteger(body.count) || body.count < 0 || body.count > 64
    || !Number.isSafeInteger(body.duplicateDeclarationCount) || body.duplicateDeclarationCount < 0
    || !Array.isArray(body.packageIds) || !Array.isArray(body.packages)
    || !Array.isArray(body.duplicateDeclarations)
    || body.packageIds.length !== body.count || body.packages.length !== body.count
    || body.duplicateDeclarations.length !== body.duplicateDeclarationCount) {
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

  const packageIdsByCapability = new Map();
  for (const packageValue of packages) {
    for (const capabilityId of packageValue.capabilities) {
      const packageIds = packageIdsByCapability.get(capabilityId) ?? [];
      packageIds.push(packageValue.id);
      packageIdsByCapability.set(capabilityId, packageIds);
    }
  }
  const expectedDuplicateDeclarations = [...packageIdsByCapability.entries()]
    .filter(([, packageIds]) => packageIds.length >= 2)
    .map(([capabilityId, packageIds]) => {
      const sortedPackageIds = [...packageIds].sort((left, right) => left.localeCompare(right, 'en'));
      return { capabilityId, packageIds: sortedPackageIds };
    })
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId, 'en'));
  if (body.duplicateDeclarationCount !== expectedDuplicateDeclarations.length
    || body.duplicateDeclarations.some((declaration, index) => {
      if (!exact(declaration, ['capabilityId', 'packageIds'])
        || !CAPABILITY_ID.test(declaration.capabilityId)
        || !Array.isArray(declaration.packageIds) || declaration.packageIds.length < 2
        || declaration.packageIds.length > 64
        || declaration.packageIds.some((id) => typeof id !== 'string' || !PLUGIN_ID.test(id)
          || !packageIds.includes(id))
        || new Set(declaration.packageIds).size !== declaration.packageIds.length
        || declaration.packageIds.some((id, packageIndex) => packageIndex > 0
          && declaration.packageIds[packageIndex - 1].localeCompare(id, 'en') >= 0)
        || index > 0
          && body.duplicateDeclarations[index - 1].capabilityId.localeCompare(declaration.capabilityId, 'en') >= 0) {
        return true;
      }
      const expected = expectedDuplicateDeclarations[index];
      return !expected || expected.capabilityId !== declaration.capabilityId
        || expected.packageIds.length !== declaration.packageIds.length
        || expected.packageIds.some((id, packageIndex) => id !== declaration.packageIds[packageIndex]);
    })) {
    throw new TypeError('Plugin capability catalog response is invalid.');
  }
  const duplicateDeclarations = Object.freeze(body.duplicateDeclarations.map((declaration) => Object.freeze({
    capabilityId: declaration.capabilityId,
    packageIds: Object.freeze([...declaration.packageIds]),
  })));
  return Object.freeze({
    schemaVersion: 1,
    kind: 'selected-extension-metadata-catalog',
    localOnly: true,
    metadataOnly: true,
    count: body.count,
    packageIds: Object.freeze(packageIds),
    packages: Object.freeze(packages),
    duplicateDeclarationCount: body.duplicateDeclarationCount,
    duplicateDeclarations,
  });
}

export function createPluginPackageEndpoints({ request }) {
  if (typeof request !== 'function') throw new TypeError('Plugin package endpoints require request transport.');
  return Object.freeze({
    listSelectedExtensionMetadata(options = {}) {
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
    }).then((response) => response.json()).then((body) => selectionResult(body, 'install'));
    },
    selectPluginPackage(id, version, options = {}) {
      if (!PLUGIN_ID.test(id ?? '') || !SEMVER.test(version ?? '') || !optionsValid(options)) {
        throw new TypeError('Plugin selection options are invalid.');
      }
      return request(`/api/plugin-packages/${encodeURIComponent(id)}/select?version=${encodeURIComponent(version)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: options.signal,
      }).then((response) => response.json()).then((body) => selectionResult(body, 'select'));
    },
    rollbackPluginPackage(id, options = {}) {
      if (!PLUGIN_ID.test(id ?? '') || !optionsValid(options)) throw new TypeError('Plugin rollback options are invalid.');
      return request(`/api/plugin-packages/${encodeURIComponent(id)}/rollback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: options.signal,
    }).then((response) => response.json()).then((body) => selectionResult(body, 'rollback'));
    },
  });
}

export { capabilityCatalog, pluginSummary };
