import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';

const SHA256 = /^[0-9a-f]{64}$/;
const COPY_BUFFER_BYTES = 1024 * 1024;
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']);

function checkedOptions({
  sourcePath, targetPath, expectedSha256, expectedSize, maximumBytes, signal,
}) {
  if (typeof sourcePath !== 'string' || !sourcePath.startsWith('/') || sourcePath.includes('\0')
    || typeof targetPath !== 'string' || !targetPath.startsWith('/') || targetPath.includes('\0')
    || sourcePath === targetPath || !SHA256.test(expectedSha256 ?? '')
    || !Number.isSafeInteger(expectedSize) || expectedSize < 5
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < expectedSize
    || (signal !== undefined && (signal === null || typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'))) {
    throw new TypeError('Private source-copy options are invalid.');
  }
  return { sourcePath, targetPath, expectedSha256, expectedSize, maximumBytes, signal };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Private source copy was cancelled.');
}

function validRegularFile(metadata, maximumBytes, expectedSize = null) {
  return metadata.isFile() && metadata.nlink === 1n
    && metadata.size >= 5n && metadata.size <= BigInt(maximumBytes)
    && (expectedSize === null || metadata.size === BigInt(expectedSize));
}

function sameIdentity(left, right) {
  return IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function frozenIdentity(metadata) {
  return Object.freeze(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, metadata[key]])));
}

async function digestHandle(handle, expectedBytes) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, Math.max(1, expectedBytes)));
  let offset = 0;
  while (offset < expectedBytes) {
    const length = Math.min(buffer.length, expectedBytes - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead < 1) throw new Error('Private source copy ended before its recorded size.');
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  if ((await handle.read(trailing, 0, 1, offset)).bytesRead !== 0) {
    throw new Error('Private source copy grew while it was being read.');
  }
  return hash.digest('hex');
}

async function writeAll(handle, buffer, length, position, signal) {
  let written = 0;
  while (written < length) {
    throwIfAborted(signal);
    const result = await handle.write(buffer, written, length - written, position + written);
    if (result.bytesWritten < 1) throw new Error('Private source copy could not be written completely.');
    written += result.bytesWritten;
  }
}

export async function stagePrivateSourceCopy(options) {
  const checked = checkedOptions(options);
  let source = null;
  let target = null;
  let targetCreated = false;
  try {
    throwIfAborted(checked.signal);
    source = await open(checked.sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const sourceBefore = await source.stat({ bigint: true });
    if (!validRegularFile(sourceBefore, checked.maximumBytes, checked.expectedSize)) {
      throw new Error('The recorded source is not a bounded single-link regular file.');
    }
    target = await open(checked.targetPath, 'wx', 0o600);
    targetCreated = true;
    throwIfAborted(checked.signal);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, checked.expectedSize));
    let offset = 0;
    while (offset < checked.expectedSize) {
      throwIfAborted(checked.signal);
      const length = Math.min(buffer.length, checked.expectedSize - offset);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead < 1) throw new Error('The recorded source ended during descriptor copy.');
      throwIfAborted(checked.signal);
      hash.update(buffer.subarray(0, bytesRead));
      await writeAll(target, buffer, bytesRead, offset, checked.signal);
      offset += bytesRead;
    }
    throwIfAborted(checked.signal);
    const trailing = Buffer.allocUnsafe(1);
    if ((await source.read(trailing, 0, 1, offset)).bytesRead !== 0) {
      throw new Error('The recorded source grew during descriptor copy.');
    }
    const sourceAfter = await source.stat({ bigint: true });
    if (!sameIdentity(sourceBefore, sourceAfter)
      || hash.digest('hex') !== checked.expectedSha256) {
      throw new Error('The recorded source changed or did not match its SHA-256 during descriptor copy.');
    }
    throwIfAborted(checked.signal);
    await target.sync();
    throwIfAborted(checked.signal);
    await target.chmod(0o400);
    const targetMetadata = await target.stat({ bigint: true });
    if (!validRegularFile(targetMetadata, checked.maximumBytes, checked.expectedSize)
      || (targetMetadata.mode & 0o077n) !== 0n) {
      throw new Error('The private source copy is not a bounded private regular file.');
    }
    return frozenIdentity(targetMetadata);
  } catch (error) {
    if (targetCreated) await unlink(checked.targetPath).catch(() => {});
    throw error;
  } finally {
    await Promise.all([source?.close().catch(() => {}), target?.close().catch(() => {})]);
  }
}

export async function assertPrivateSourceCopy({ path, identity, expectedSha256, expectedSize, maximumBytes }) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')
    || !identity || typeof identity !== 'object' || !SHA256.test(expectedSha256 ?? '')
    || !Number.isSafeInteger(expectedSize) || expectedSize < 5
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < expectedSize) {
    throw new TypeError('Private source-copy assertion options are invalid.');
  }
  let handle = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!validRegularFile(before, maximumBytes, expectedSize)
      || (before.mode & 0o077n) !== 0n || !sameIdentity(before, identity)) {
      throw new Error('The private source copy identity changed before validation.');
    }
    const digest = await digestHandle(handle, expectedSize);
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after) || digest !== expectedSha256) {
      throw new Error('The private source copy changed during validation.');
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}
