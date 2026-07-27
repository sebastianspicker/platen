import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { HostError } from '../host/host-error.mjs';
import { createLocalSbom, validateLocalSbom } from './local-sbom.mjs';

export const LOCAL_RELEASE_POLICY_SCHEMA = 'pdf-local-release-policy-v1';
export const DEFAULT_RELEASE_LIMITS = Object.freeze({
  maxDepth: 8,
  maxFiles: 1_024,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_SEGMENT = /^(?:\.env(?:\..*)?|.*(?:token|secret|credential|password|private[-_.]?key|auth(?:entication)?|key)(?:[-_.].*)?|.*\.(?:key|pem|p12|pfx))$/i;
const NODE_ENGINE = /^>=\d+(?:\.\d+(?:\.\d+)?)?(?:\s+<\d+(?:\.\d+(?:\.\d+)?)?)?$/;

function releaseError(code, message) {
  return new HostError(code, message, 422);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw releaseError('RELEASE_POLICY_INVALID', `${name} must use the required local release policy fields.`);
  }
}

async function checkedRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) {
    throw new TypeError('root must be a trusted absolute path without NUL bytes');
  }
  const directRoot = resolve(root);
  try {
    const metadata = await lstat(directRoot, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw releaseError('RELEASE_ROOT_UNSAFE', 'The local release root must be a direct directory.');
    }
    return Object.freeze({
      path: directRoot,
      identity: Object.freeze({ dev: metadata.dev, ino: metadata.ino }),
    });
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw releaseError('RELEASE_ROOT_UNSAFE', 'The local release root must be a direct directory.');
  }
}

function checkedPath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || path.includes('\0')
    || isAbsolute(path) || path.includes('\\')) return null;
  const segments = path.split('/');
  if (segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..'
    || SECRET_SEGMENT.test(segment))) return null;
  return path;
}

function checkedLimits(limits) {
  exactKeys(limits, ['maxDepth', 'maxFiles', 'maxFileBytes', 'maxTotalBytes'], 'limits');
  for (const [key, maximum] of Object.entries({ maxDepth: 32, maxFiles: 10_000, maxFileBytes: 256 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 })) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) {
      throw releaseError('RELEASE_POLICY_INVALID', `limits.${key} is outside the supported local validation bounds.`);
    }
  }
  if (limits.maxFileBytes > limits.maxTotalBytes) {
    throw releaseError('RELEASE_POLICY_INVALID', 'limits.maxFileBytes cannot exceed limits.maxTotalBytes.');
  }
  return Object.freeze({ ...limits });
}

function checkedPolicy(policy) {
  exactKeys(policy, ['schema', 'requiredPaths', 'package', 'limits'], 'policy');
  if (policy.schema !== LOCAL_RELEASE_POLICY_SCHEMA || !Array.isArray(policy.requiredPaths)
    || policy.requiredPaths.length < 1) throw releaseError('RELEASE_POLICY_INVALID', 'The local release policy is not supported.');
  const requiredPaths = policy.requiredPaths.map(checkedPath);
  if (requiredPaths.some((path) => path === null) || new Set(requiredPaths).size !== requiredPaths.length
    || !requiredPaths.includes('package.json')) {
    throw releaseError('RELEASE_POLICY_INVALID', 'The policy must name unique safe relative paths including package.json.');
  }
  const limits = checkedLimits(policy.limits);
  if (requiredPaths.length > limits.maxFiles) {
    throw releaseError('RELEASE_POLICY_INVALID', 'The required file count exceeds the policy file bound.');
  }
  for (const path of requiredPaths) {
    if (path.split('/').length > limits.maxDepth) {
      throw releaseError('RELEASE_POLICY_INVALID', 'A required path exceeds the policy depth bound.');
    }
  }
  exactKeys(policy.package, ['name', 'version', 'nodeEngine', 'license', 'private'], 'package');
  const { name, version, nodeEngine, license, private: isPrivate } = policy.package;
  if (typeof name !== 'string' || !name || name.length > 214 || typeof version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    || typeof nodeEngine !== 'string' || !NODE_ENGINE.test(nodeEngine)
    || typeof license !== 'string' || !/^[A-Za-z0-9.-]{1,128}$/.test(license)
    || typeof isPrivate !== 'boolean') {
    throw releaseError('RELEASE_POLICY_INVALID', 'The package policy contains an invalid expected value.');
  }
  return Object.freeze({
    schema: policy.schema,
    requiredPaths: Object.freeze([...requiredPaths].sort()),
    package: Object.freeze({ name, version, nodeEngine, license, private: isPrivate }),
    limits,
  });
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function failure(name, code) { return Object.freeze({ name, status: 'fail', code }); }
function passed(name) { return Object.freeze({ name, status: 'pass', code: null }); }
function notChecked(name, code) { return Object.freeze({ name, status: 'not-checked', code }); }

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function snapshotSafeAncestors(root, path, expectedRootIdentity) {
  const segments = path.split('/');
  let ancestor = root;
  const snapshots = [];
  try {
    const rootMetadata = await lstat(root, { bigint: true });
    if (!rootMetadata.isDirectory()
      || rootMetadata.isSymbolicLink()
      || !sameDirectoryIdentity(rootMetadata, expectedRootIdentity)) {
      throw releaseError('RELEASE_ROOT_CHANGED', 'The local release root changed during validation.');
    }
    snapshots.push(Object.freeze({ path: root, metadata: rootMetadata }));
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw releaseError('RELEASE_ROOT_CHANGED', 'The local release root changed during validation.');
  }
  for (const segment of segments.slice(0, -1)) {
    ancestor = resolve(ancestor, segment);
    try {
      const metadata = await lstat(ancestor, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw releaseError('RELEASE_PATH_ANCESTOR_UNSAFE', 'A required release path has an unsafe ancestor.');
      }
      snapshots.push(Object.freeze({ path: ancestor, metadata }));
    } catch (error) {
      if (error instanceof HostError) throw error;
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        throw releaseError('RELEASE_FILE_MISSING', 'A required release file is missing.');
      }
      throw releaseError('RELEASE_PATH_ANCESTOR_UNSAFE', 'A required release path has an unsafe ancestor.');
    }
  }
  return Object.freeze(snapshots);
}

async function assertAncestorsUnchanged(snapshots) {
  for (const snapshot of snapshots) {
    try {
      const metadata = await lstat(snapshot.path, { bigint: true });
      if (!metadata.isDirectory()
        || metadata.isSymbolicLink()
        || !sameDirectoryIdentity(metadata, snapshot.metadata)) {
        throw releaseError(
          'RELEASE_PATH_ANCESTOR_CHANGED',
          'A required release path ancestor changed during validation.',
        );
      }
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw releaseError(
        'RELEASE_PATH_ANCESTOR_CHANGED',
        'A required release path ancestor changed during validation.',
      );
    }
  }
}

async function readRegularFile(releaseRoot, path, limits) {
  const candidate = resolve(releaseRoot.path, path);
  if (!inside(releaseRoot.path, candidate)) throw releaseError('RELEASE_PATH_INVALID', 'A required path is outside the local release root.');
  const ancestors = await snapshotSafeAncestors(
    releaseRoot.path,
    path,
    releaseRoot.identity,
  );
  let handle;
  try {
    const before = await lstat(candidate, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > BigInt(limits.maxFileBytes)) throw releaseError('RELEASE_FILE_UNSAFE', 'A required release file is not a safe bounded regular file.');
    handle = await open(candidate, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened)) {
      throw releaseError('RELEASE_FILE_UNSAFE', 'A required release file changed before validation.');
    }
    const size = Number(opened.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead < 1) throw releaseError('RELEASE_FILE_CHANGED', 'A required release file changed while validation was reading it.');
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(opened, after)) throw releaseError('RELEASE_FILE_CHANGED', 'A required release file changed while validation was reading it.');
    await assertAncestorsUnchanged(ancestors);
    return Object.freeze({ bytes, sha256: createHash('sha256').update(bytes).digest('hex'), size });
  } catch (error) {
    if (error instanceof HostError) throw error;
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw releaseError('RELEASE_FILE_MISSING', 'A required release file is missing.');
    throw releaseError('RELEASE_FILE_UNREADABLE', 'A required release file could not be safely read.');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function packageMatches(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.name === expected.name && value.version === expected.version
    && value.engines && typeof value.engines === 'object' && !Array.isArray(value.engines)
    && value.engines.node === expected.nodeEngine && value.license === expected.license
    && value.private === expected.private;
}

/**
 * Validates a host-composed local release policy. It performs no network or subprocess work,
 * and only reads the explicitly required regular files named by that policy. Node does not
 * expose openat-style directory-relative traversal, so root and ancestor identities are pinned
 * before and after each descriptor read. Detected identity changes are rejected, but an ABA swap
 * cannot be excluded and bytes may be read before postflight; the root must be trusted and quiet.
 */
export async function validateLocalRelease({ root, policy } = {}) {
  const releaseRoot = await checkedRoot(root);
  const checked = checkedPolicy(policy);
  const checks = [];
  let totalBytes = 0;
  const files = [];
  let packageBytes = null;

  for (const path of checked.requiredPaths) {
    try {
      const item = await readRegularFile(releaseRoot, path, checked.limits);
      totalBytes += item.size;
      if (totalBytes > checked.limits.maxTotalBytes) throw releaseError('RELEASE_TOTAL_BYTES_EXCEEDED', 'The bounded local release inventory is too large.');
      files.push(Object.freeze({ path, sha256: item.sha256, size: item.size }));
      if (path === 'package.json') packageBytes = item.bytes;
    } catch (error) {
      checks.push(failure(`required-file:${path}`, error.code ?? 'RELEASE_FILE_UNREADABLE'));
    }
  }
  checks.push(files.length === checked.requiredPaths.length ? passed('required-files') : failure('required-files', 'RELEASE_REQUIRED_FILES_FAILED'));
  checks.push(files.length === checked.requiredPaths.length ? passed('sha256-inventory') : notChecked('sha256-inventory', 'RELEASE_REQUIRED_FILES_FAILED'));

  let pkg = null;
  try {
    pkg = packageBytes ? JSON.parse(packageBytes.toString('utf8')) : null;
    if (!packageMatches(pkg, checked.package)) throw releaseError('RELEASE_PACKAGE_METADATA_INVALID', 'Package metadata does not match the local release policy.');
    checks.push(passed('package-metadata'));
  } catch (error) {
    checks.push(failure('package-metadata', error.code ?? 'RELEASE_PACKAGE_INVALID'));
  }
  try {
    if (!pkg || !packageMatches(pkg, checked.package)) {
      throw releaseError('RELEASE_PACKAGE_METADATA_INVALID', 'Package metadata does not match the local release policy.');
    }
    const dependencyNames = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    if (dependencyNames.some((name) => pkg[name] !== undefined && (!pkg[name] || typeof pkg[name] !== 'object' || Array.isArray(pkg[name]) || Object.keys(pkg[name]).length))) {
      throw releaseError('RELEASE_DEPENDENCIES_DECLARED', 'The local release package declares dependencies.');
    }
    checks.push(passed('declared-dependencies'));
  } catch (error) {
    checks.push(error.code === 'RELEASE_PACKAGE_METADATA_INVALID'
      ? notChecked('declared-dependencies', error.code)
      : failure('declared-dependencies', error.code ?? 'RELEASE_PACKAGE_INVALID'));
  }
  checks.push(notChecked('signing', 'EXTERNAL_RELEASE_EVIDENCE_NOT_PROVIDED'));
  checks.push(notChecked('notarization', 'EXTERNAL_RELEASE_EVIDENCE_NOT_PROVIDED'));
  let sbom = null;
  try {
    const dependencyNames = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    const emptyDependencies = pkg && dependencyNames.every((name) => pkg[name] === undefined || pkg[name] && typeof pkg[name] === 'object' && !Array.isArray(pkg[name]) && Object.keys(pkg[name]).length === 0);
    if (files.length !== checked.requiredPaths.length || !packageMatches(pkg, checked.package) || !emptyDependencies) throw releaseError('RELEASE_SBOM_NOT_READY', 'Local SBOM generation requires a complete dependency-free release inventory.');
    sbom = validateLocalSbom(createLocalSbom({ files: [...files].sort((left, right) => left.path.localeCompare(right.path)), packageMetadata: checked.package, dependencyGroups: Object.fromEntries(dependencyNames.map((name) => [name, []])) }));
    checks.push(passed('sbom'));
  } catch (error) {
    checks.push(notChecked('sbom', error.code ?? 'RELEASE_SBOM_NOT_READY'));
  }

  const receipt = {
    schema: 'pdf-local-release-receipt-v2',
    scope: 'local-inventory',
    status: checks.some((check) => check.status === 'fail') ? 'fail' : 'pass',
    distributionStatus: 'not-ready',
    checks: Object.freeze(checks),
    inventory: Object.freeze({ files: Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path))), totalBytes }),
    sbom,
  };
  return deepFreeze(receipt);
}

export function isSha256(value) { return typeof value === 'string' && SHA256.test(value); }
