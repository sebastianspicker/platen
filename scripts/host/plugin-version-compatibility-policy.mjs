import {
  JAVASCRIPTCORE_CLASSIC_RUNTIME,
  PLUGIN_ID,
  SEMVER,
  SHA256,
  isPlainObject,
} from './plugin-package-contract.mjs';

const PLATFORM_PLUGIN_POLICY = Object.freeze({
  packageVersion: 1,
  manifestVersions: Object.freeze([2, 3]),
  protocolVersion: 1,
  executableRuntime: Object.freeze({
    kind: JAVASCRIPTCORE_CLASSIC_RUNTIME.kind,
    apiVersion: JAVASCRIPTCORE_CLASSIC_RUNTIME.apiVersion,
  }),
  v3DependenciesDisabled: true,
  dependencyPins: Object.freeze({
    exact: true,
    fields: Object.freeze(['id', 'version', 'digest']),
  }),
  evaluationAuthority: 'advisory-only',
  enforcementStages: Object.freeze([
    Object.freeze({ stage: 'manifest-validation', enforcedBy: 'signed-package-install' }),
    Object.freeze({ stage: 'activation-dependency-resolution', enforcedBy: 'plugin-package-store' }),
  ]),
});

const DEPENDENCY_DUPLICATE_ID = 'dependency-id-duplicate';
const DEPENDENCY_ID_INVALID = 'dependency-id-invalid';
const DEPENDENCY_SELF = 'dependency-self';
const DEPENDENCY_VERSION_INVALID = 'dependency-version-invalid';
const DEPENDENCY_DIGEST_INVALID = 'dependency-digest-invalid';
const DEPENDENCY_NOT_OBJECT = 'dependency-not-object';
const DEPENDENCY_FIELDS_INVALID = 'dependency-fields-invalid';
const DEPS_REQUIRED_ZERO = 'dependencies-required-zero';
const MANIFEST_DEPENDENCIES_INVALID = 'dependencies-not-array';
const MANIFEST_NOT_PROVIDED = 'manifest-not-provided';
const MANIFEST_VERSION_UNSUPPORTED = 'manifest-version-unsupported';
const MANIFEST_RUNTIME_REQUIRED = 'runtime-required';
const MANIFEST_RUNTIME_INVALID = 'runtime-invalid';
const MANIFEST_RUNTIME_FORBIDDEN = 'manifest-v2-runtime-forbidden';
const PACKAGES_VERSION_MISMATCH = 'package-version-unsupported';
const PROTOCOL_VERSION_UNSUPPORTED = 'protocol-version-unsupported';

function evaluateManifestDependencies(dependencies, packageId, violations) {
  if (!Array.isArray(dependencies)) {
    violations.push(MANIFEST_DEPENDENCIES_INVALID);
    return;
  }
  const seenIds = new Set();
  for (const dependency of dependencies) {
    if (!isPlainObject(dependency)) {
      violations.push(DEPENDENCY_NOT_OBJECT);
      continue;
    }
    const keys = Object.keys(dependency);
    if (keys.length !== 3 || keys.some((key) => !['digest', 'id', 'version'].includes(key))) {
      violations.push(DEPENDENCY_FIELDS_INVALID);
      continue;
    }
    const hasValidId = typeof dependency.id === 'string' && PLUGIN_ID.test(dependency.id);
    const hasValidVersion = typeof dependency.version === 'string' && SEMVER.test(dependency.version);
    const hasValidDigest = typeof dependency.digest === 'string' && SHA256.test(dependency.digest);
    if (!hasValidId) violations.push(DEPENDENCY_ID_INVALID);
    if (!hasValidVersion) violations.push(DEPENDENCY_VERSION_INVALID);
    if (!hasValidDigest) violations.push(DEPENDENCY_DIGEST_INVALID);
    if (hasValidId) {
      if (dependency.id === packageId) violations.push(DEPENDENCY_SELF);
      if (seenIds.has(dependency.id)) violations.push(DEPENDENCY_DUPLICATE_ID);
      seenIds.add(dependency.id);
    }
  }
}

function evaluateManifestVersionCompat(manifest, packageId) {
  const policy = PLATFORM_PLUGIN_POLICY;
  if (!isPlainObject(manifest)) {
    return {
      policy,
      evaluated: false,
      compatible: false,
      violations: Object.freeze([MANIFEST_NOT_PROVIDED]),
    };
  }
  const mutableViolations = [];
  if (manifest.packageVersion !== 1) mutableViolations.push(PACKAGES_VERSION_MISMATCH);
  if (manifest.manifestVersion !== 2 && manifest.manifestVersion !== 3) {
    mutableViolations.push(MANIFEST_VERSION_UNSUPPORTED);
  }
  if (manifest.protocolVersion !== 1) mutableViolations.push(PROTOCOL_VERSION_UNSUPPORTED);

  if (manifest.manifestVersion === 2) {
    if (Object.hasOwn(manifest, 'runtime')) mutableViolations.push(MANIFEST_RUNTIME_FORBIDDEN);
    evaluateManifestDependencies(manifest.dependencies, packageId, mutableViolations);
  }
  if (manifest.manifestVersion === 3) {
    if (!isPlainObject(manifest.runtime)) {
      mutableViolations.push(MANIFEST_RUNTIME_REQUIRED);
    } else {
      const runtimeKeys = Object.keys(manifest.runtime);
      if (
        runtimeKeys.length !== 2
        || runtimeKeys.some((key) => !['kind', 'apiVersion'].includes(key))
        || manifest.runtime.kind !== JAVASCRIPTCORE_CLASSIC_RUNTIME.kind
        || manifest.runtime.apiVersion !== JAVASCRIPTCORE_CLASSIC_RUNTIME.apiVersion
      ) {
        mutableViolations.push(MANIFEST_RUNTIME_INVALID);
      }
    }
    if (!Array.isArray(manifest.dependencies)) {
      mutableViolations.push(MANIFEST_DEPENDENCIES_INVALID);
    } else if (manifest.dependencies.length !== 0) {
      mutableViolations.push(DEPS_REQUIRED_ZERO);
    }
  }

  return {
    policy,
    evaluated: true,
    compatible: mutableViolations.length === 0,
    violations: Object.freeze([...mutableViolations]),
  };
}

export function evaluatePluginVersionCompatibilityPolicy(manifest, packageId) {
  return evaluateManifestVersionCompat(manifest, packageId);
}
