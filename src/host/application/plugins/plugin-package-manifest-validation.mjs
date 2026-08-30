import {
  CAPABILITY_ID,
  MANIFEST_FIELDS,
  PLUGIN_ID,
  SEMVER,
  assertExactKeys,
  isPlainObject,
  packageFailure,
} from './plugin-package-contract.mjs';

function validateManifestIdentity(manifest) {
  if (!PLUGIN_ID.test(manifest.id) || typeof manifest.name !== 'string'
    || !manifest.name.trim() || !SEMVER.test(manifest.version)) {
    packageFailure('PACKAGE_MANIFEST_INVALID', 'Plugin identity is invalid.');
  }
  if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.length
    || manifest.capabilities.some(
      (item) => typeof item !== 'string' || !CAPABILITY_ID.test(item),
    ) || new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    packageFailure('PACKAGE_MANIFEST_INVALID', 'Plugin capabilities are invalid.');
  }
  if (typeof manifest.description !== 'string' || !manifest.description.trim()
    || manifest.description.length > 2_000) {
    packageFailure('PACKAGE_MANIFEST_INVALID', 'Plugin metadata description is invalid.');
  }
}

function validateManifest(manifest) {
  if (!isPlainObject(manifest) || manifest.manifestVersion !== 1) {
    packageFailure('PACKAGE_MANIFEST_INVALID', 'Plugin manifest version is unsupported.');
  }
  for (const field of [
    'activation', 'entry', 'runtime', 'provider', 'providerId', 'selectedProviderId', 'providers',
    'loader', 'dispatcher', 'rpc', 'sandbox', 'code', 'permissions', 'dependencies',
    'protocolVersion', 'files',
  ]) {
    if (Object.hasOwn(manifest, field)) packageFailure('PACKAGE_MANIFEST_EXECUTABLE_FIELD_FORBIDDEN', `Plugin metadata must not contain ${field}.`);
  }
  assertExactKeys(manifest, MANIFEST_FIELDS, 'Plugin manifest');
  validateManifestIdentity(manifest);
}

export function validatePluginPackageManifest(pluginPackage) {
  if (!isPlainObject(pluginPackage) || pluginPackage.packageVersion !== 1) {
    packageFailure('PACKAGE_INVALID', 'Plugin package version is invalid.');
  }
  if (Object.hasOwn(pluginPackage, 'files') || Object.hasOwn(pluginPackage, 'payload')) {
    packageFailure('PACKAGE_PAYLOAD_FORBIDDEN', 'Signed plugin metadata packages must not contain payload files.');
  }
  validateManifest(pluginPackage.manifest);
  return Object.freeze({ manifest: Object.freeze(structuredClone(pluginPackage.manifest)) });
}
