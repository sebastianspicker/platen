import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const MAX_NATIVE_HELPER_BYTES = 64 * 1024 * 1024;

const MACH_O_MAGICS = new Set([
  'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
  'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca',
]);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
const DESTINATION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

function descendant(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${String.fromCharCode(47)}`) && !isAbsolute(path);
}

function safeAbsolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${name} must be an absolute path without NUL bytes`);
  }
  return resolve(value);
}

function checkedLabel(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9 -]{0,63}$/.test(value)) {
    throw new TypeError('label must be a short printable identifier');
  }
  return value;
}

function checkedCandidates(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8) {
    throw new TypeError('candidates must contain one through eight fixed helper candidates');
  }
  return Object.freeze(value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.keys(candidate).length !== 2
      || typeof candidate.kind !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(candidate.kind)
      || typeof candidate.relativePath !== 'string' || !candidate.relativePath
      || isAbsolute(candidate.relativePath) || candidate.relativePath.includes('\0')) {
      throw new TypeError('Each helper candidate must have a fixed kind and relative path');
    }
    return Object.freeze({ kind: candidate.kind, relativePath: candidate.relativePath });
  }));
}

function currentUid() {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
}

function safeExecutableMetadata(metadata, { exactMode = null } = {}) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
    || metadata.size < 4n || metadata.size > BigInt(MAX_NATIVE_HELPER_BYTES)
    || (metadata.mode & 0o022n) !== 0n || (metadata.mode & 0o6000n) !== 0n
    || (metadata.mode & 0o100n) === 0n || (exactMode !== null && (metadata.mode & 0o777n) !== BigInt(exactMode))) return false;
  const uid = currentUid();
  return uid === null || metadata.uid === uid;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function hashOpenMachO(path, { exactMode = null, label } = {}) {
  const pathname = safeAbsolute(path, 'executable');
  const expected = await lstat(pathname, { bigint: true });
  if (!safeExecutableMetadata(expected, { exactMode })) throw new Error(`Unsafe ${label} metadata`);
  const handle = await open(pathname, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!safeExecutableMetadata(opened, { exactMode }) || !sameIdentity(expected, opened)) {
      throw new Error(`${label} changed before it could be read`);
    }
    const size = Number(opened.size);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, size));
    const hash = createHash('sha256');
    let position = 0;
    let magic = null;
    while (position < size) {
      const requested = Math.min(buffer.length, size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead !== requested) throw new Error(`${label} changed while it was read`);
      if (position === 0) magic = buffer.subarray(0, 4).toString('hex');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (!MACH_O_MAGICS.has(magic)) throw new Error(`${label} is not a Mach-O executable`);
    const finalMetadata = await handle.stat({ bigint: true });
    if (!sameIdentity(opened, finalMetadata)) throw new Error(`${label} changed while it was read`);
    return Object.freeze({ sha256: hash.digest('hex'), size });
  } finally {
    await handle.close();
  }
}

async function privateDirectory(path, label) {
  const pathname = safeAbsolute(path, 'sessionRoot');
  const metadata = await lstat(pathname, { bigint: true });
  const uid = currentUid();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077n) !== 0n
    || (uid !== null && metadata.uid !== uid)) throw new Error(`${label} destination must be a private directory`);
  return realpath(pathname);
}

async function copyPinnedExecutable(source, destination, label) {
  const sourcePath = safeAbsolute(source, 'source');
  const destinationPath = safeAbsolute(destination, 'destination');
  const sourceMetadata = await lstat(sourcePath, { bigint: true });
  if (!safeExecutableMetadata(sourceMetadata)) throw new Error(`Unsafe ${label} metadata`);
  const sourceHandle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let destinationHandle;
  try {
    const openedSource = await sourceHandle.stat({ bigint: true });
    if (!safeExecutableMetadata(openedSource) || !sameIdentity(sourceMetadata, openedSource)) {
      throw new Error(`${label} changed before staging`);
    }
    destinationHandle = await open(destinationPath, 'wx', 0o500);
    const size = Number(openedSource.size);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, size));
    const hash = createHash('sha256');
    let position = 0;
    let magic = null;
    while (position < size) {
      const requested = Math.min(buffer.length, size - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, requested, position);
      if (bytesRead !== requested) throw new Error(`${label} changed while staging`);
      if (position === 0) magic = buffer.subarray(0, 4).toString('hex');
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw new Error(`${label} staging was incomplete`);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if (!MACH_O_MAGICS.has(magic)) throw new Error(`${label} is not a Mach-O executable`);
    const finalSource = await sourceHandle.stat({ bigint: true });
    if (!sameIdentity(openedSource, finalSource)) throw new Error(`${label} changed while staging`);
    await destinationHandle.sync();
    await destinationHandle.chmod(0o500);
    const sha256 = hash.digest('hex');
    await destinationHandle.close();
    destinationHandle = null;
    const staged = await hashOpenMachO(destinationPath, { exactMode: 0o500, label });
    if (staged.sha256 !== sha256 || staged.size !== size) throw new Error(`Staged ${label} digest mismatch`);
    return Object.freeze({ executable: destinationPath, sha256, size });
  } catch (error) {
    await destinationHandle?.close().catch(() => {});
    await unlink(destinationPath).catch(() => {});
    throw error;
  } finally {
    await sourceHandle.close();
  }
}

export async function stageNativeHelper({
  root, sessionRoot, candidates, destinationName, label, platform = process.platform,
} = {}) {
  const helperLabel = checkedLabel(label);
  const helperCandidates = checkedCandidates(candidates);
  if (!DESTINATION_NAME_PATTERN.test(destinationName ?? '')) {
    throw new TypeError('destinationName must be a safe fixed executable name');
  }
  if (platform !== 'darwin') return Object.freeze({ available: false, reason: 'unsupported-platform' });
  const projectRoot = await realpath(safeAbsolute(root, 'root'));
  const privateRoot = await privateDirectory(sessionRoot, helperLabel);
  const helpersDirectory = join(privateRoot, 'helpers');
  await mkdir(helpersDirectory, { recursive: true, mode: 0o700 });
  await chmod(helpersDirectory, 0o700);
  await privateDirectory(helpersDirectory, helperLabel);

  let selected = null;
  for (const candidate of helperCandidates) {
    const path = resolve(projectRoot, candidate.relativePath);
    if (!descendant(projectRoot, path)) throw new Error(`${helperLabel} candidate escaped the project root`);
    try {
      const candidateMetadata = await lstat(path, { bigint: true });
      if (candidateMetadata.isSymbolicLink()) throw new Error(`Unsafe ${helperLabel} metadata`);
      const resolvedPath = await realpath(path);
      if (!descendant(projectRoot, resolvedPath)) throw new Error(`${helperLabel} candidate escaped the project root`);
      selected = { ...candidate, path: resolvedPath };
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!selected) return Object.freeze({ available: false, reason: 'release-helper-not-built' });
  const staged = await copyPinnedExecutable(selected.path, join(helpersDirectory, destinationName), helperLabel);
  return Object.freeze({ available: true, kind: selected.kind, ...staged });
}

export async function verifyStagedNativeHelper({ executable, expectedSha256, label } = {}) {
  const helperLabel = checkedLabel(label);
  if (typeof expectedSha256 !== 'string' || !DIGEST_PATTERN.test(expectedSha256)) {
    throw new TypeError('expectedSha256 must be a SHA-256 digest');
  }
  const inspected = await hashOpenMachO(executable, { exactMode: 0o500, label: helperLabel });
  if (inspected.sha256 !== expectedSha256.toLowerCase()) throw new Error(`${helperLabel} digest mismatch`);
  return true;
}
