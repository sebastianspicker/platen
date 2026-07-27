import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const VERAPDF_SUPPORTED_VERSION = '1.30.1';
export const VERAPDF_BUNDLE_MANIFEST = 'verapdf-bundle.json';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PATH_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const MAX_COMPONENT_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

function bundleError() {
  return new Error('Invalid veraPDF bundle');
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
  return resolve(value);
}

function descendant(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${String.fromCharCode(47)}`) && !isAbsolute(path);
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
    && value.split('/').every((part) => part !== '.' && part !== '..' && PATH_COMPONENT_PATTERN.test(part));
}

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function safeComponentMetadata(metadata, { launcher = false } = {}) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n
    && metadata.size >= 0n && metadata.size <= BigInt(MAX_COMPONENT_BYTES)
    && (metadata.mode & 0o222n) === 0n && (metadata.mode & 0o6000n) === 0n
    && (!launcher || (metadata.mode & 0o100n) !== 0n);
}

function safeDirectoryMetadata(metadata) {
  return metadata.isDirectory() && !metadata.isSymbolicLink()
    && (metadata.mode & 0o222n) === 0n && (metadata.mode & 0o6000n) === 0n;
}

async function readComponent(path, {
  expectedDigest = null, launcher = false, maximumBytes = MAX_COMPONENT_BYTES, retainBytes = false,
} = {}) {
  const initial = await lstat(path, { bigint: true });
  if (!safeComponentMetadata(initial, { launcher }) || initial.size > BigInt(maximumBytes)) throw bundleError();
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!safeComponentMetadata(opened, { launcher }) || opened.size > BigInt(maximumBytes)
      || !sameIdentity(initial, opened)) throw bundleError();
    const hash = createHash('sha256');
    const bytes = retainBytes ? Buffer.alloc(Number(opened.size)) : null;
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, Number(opened.size))));
    let position = 0;
    while (position < Number(opened.size)) {
      const requested = Math.min(buffer.length, Number(opened.size) - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead !== requested) throw bundleError();
      hash.update(buffer.subarray(0, bytesRead));
      if (bytes) buffer.copy(bytes, position, 0, bytesRead);
      position += bytesRead;
    }
    const actualDigest = hash.digest('hex');
    if (!sameIdentity(opened, await handle.stat({ bigint: true }))
      || (expectedDigest !== null && actualDigest !== expectedDigest)) throw bundleError();
    return Object.freeze({ bytes, sha256: actualDigest });
  } finally {
    await handle.close();
  }
}

async function listedFiles(root, directory = root, files = new Set()) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (!descendant(root, path) || entry.isSymbolicLink()) throw bundleError();
    if (entry.isDirectory()) {
      if (!safeDirectoryMetadata(await lstat(path, { bigint: true }))) throw bundleError();
      await listedFiles(root, path, files);
    } else if (entry.isFile()) {
      files.add(relative(root, path));
    } else {
      throw bundleError();
    }
  }
  return files;
}

function parseManifest(bytes, expectedVersion) {
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { throw bundleError(); }
  if (!exactObject(manifest, ['schema', 'version', 'launcher', 'files'])
    || manifest.schema !== 'verapdf-bundle-v1' || manifest.version !== expectedVersion
    || !safeRelativePath(manifest.launcher) || !exactObject(manifest.files, Object.keys(manifest.files))) throw bundleError();
  const files = Object.entries(manifest.files);
  if (files.length === 0 || !Object.hasOwn(manifest.files, manifest.launcher)
    || files.some(([path, digest]) => !safeRelativePath(path) || typeof digest !== 'string' || !DIGEST_PATTERN.test(digest))) throw bundleError();
  return Object.freeze({ launcher: manifest.launcher, files: Object.freeze(files.map(([path, digest]) => Object.freeze([path, digest]))) });
}

/**
 * Validates a locally staged, explicitly manifested veraPDF distribution.
 * A missing manifest means no trusted bundle is installed; malformed or
 * changed bundles fail closed and never cause a PATH lookup.
 */
export async function loadVeraPdfBundle({ root, expectedVersion = VERAPDF_SUPPORTED_VERSION } = {}) {
  const rawRoot = absolutePath(root, 'root');
  if (expectedVersion !== VERAPDF_SUPPORTED_VERSION) throw new TypeError('expectedVersion must match the supported veraPDF version');
  let rootPath;
  try {
    const rootMetadata = await lstat(rawRoot, { bigint: true });
    if (!safeDirectoryMetadata(rootMetadata)) throw bundleError();
    rootPath = await realpath(rawRoot);
    const manifestPath = resolve(rootPath, VERAPDF_BUNDLE_MANIFEST);
    if (!descendant(rootPath, manifestPath)) throw bundleError();
    const manifest = await readComponent(manifestPath, { maximumBytes: MAX_MANIFEST_BYTES, retainBytes: true });
    const parsed = parseManifest(manifest.bytes.toString('utf8'), expectedVersion);
    const expectedFiles = new Set(parsed.files.map(([path]) => path));
    const actualFiles = await listedFiles(rootPath);
    actualFiles.delete(VERAPDF_BUNDLE_MANIFEST);
    if (actualFiles.size !== expectedFiles.size || [...actualFiles].some((path) => !expectedFiles.has(path))) throw bundleError();
    for (const [path, digest] of parsed.files) {
      const componentPath = resolve(rootPath, path);
      if (!descendant(rootPath, componentPath) || await realpath(componentPath) !== componentPath) throw bundleError();
      await readComponent(componentPath, { expectedDigest: digest, launcher: path === parsed.launcher });
    }
    const bundleDigest = manifest.sha256;
    return Object.freeze({
      launcher: resolve(rootPath, parsed.launcher),
      version: expectedVersion,
      profileMap: Object.freeze({
        'pdfa-1a': '1a', 'pdfa-1b': '1b', 'pdfa-2a': '2a', 'pdfa-2b': '2b', 'pdfa-2u': '2u',
        'pdfa-3a': '3a', 'pdfa-3b': '3b', 'pdfa-3u': '3u', 'pdfa-4': '4', 'pdfa-4e': '4e',
        'pdfa-4f': '4f', 'pdfua-1': 'ua1', 'pdfua-2': 'ua2',
      }),
      evidence: Object.freeze({ bundleDigest, componentCount: parsed.files.length }),
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof TypeError) throw error;
    throw bundleError();
  }
}
