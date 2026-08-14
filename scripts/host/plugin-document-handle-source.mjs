import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const DIGEST_BUFFER_BYTES = 64 * 1024;

function sameIdentity(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]);
}

function isPrivateSingleLinkRegularFile(metadata, expectedSize) {
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
  return metadata.isFile() && metadata.nlink === 1n && metadata.size === BigInt(expectedSize)
    && (metadata.mode & 0o077n) === 0n && (uid === null || metadata.uid === uid);
}

async function digestDescriptor(file, expectedSize) {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(DIGEST_BUFFER_BYTES, Math.max(1, expectedSize)));
  let offset = 0;
  while (offset < expectedSize) {
    const wanted = Math.min(buffer.length, expectedSize - offset);
    const { bytesRead } = await file.read(buffer, 0, wanted, offset);
    if (bytesRead !== wanted) throw new Error('The source ended while its descriptor was being verified.');
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  if ((await file.read(trailing, 0, 1, expectedSize)).bytesRead !== 0) {
    throw new Error('The source grew while its descriptor was being verified.');
  }
  return digest.digest('hex');
}

/**
 * Reads one bounded range from the exact private source descriptor that was
 * verified against the document record immediately before and after the read.
 */
export async function readBoundedVerifiedPluginSource({ path, expectedSize, expectedSha256, offset, length }) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')
    || !Number.isSafeInteger(expectedSize) || expectedSize < 1
    || !/^[0-9a-f]{64}$/.test(expectedSha256 ?? '')
    || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(length) || length < 1 || offset + length > expectedSize) {
    throw new TypeError('Plugin source read options are invalid.');
  }
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error('Descriptor no-follow protection is unavailable.');
  }

  let file;
  try {
    const pathBefore = await lstat(path, { bigint: true });
    if (pathBefore.isSymbolicLink() || !isPrivateSingleLinkRegularFile(pathBefore, expectedSize)) {
      throw new Error('The plugin source path is not a private single-link regular file.');
    }
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const descriptorBefore = await file.stat({ bigint: true });
    if (!isPrivateSingleLinkRegularFile(descriptorBefore, expectedSize)
      || !sameIdentity(pathBefore, descriptorBefore)) {
      throw new Error('The plugin source path changed before descriptor binding.');
    }
    if (await digestDescriptor(file, expectedSize) !== expectedSha256) {
      throw new Error('The plugin source digest does not match its handle binding.');
    }

    const result = Buffer.alloc(length);
    const { bytesRead } = await file.read(result, 0, length, offset);
    if (bytesRead !== length) throw new Error('The plugin source ended during the bounded read.');

    const descriptorAfter = await file.stat({ bigint: true });
    if (!sameIdentity(descriptorBefore, descriptorAfter)
      || !isPrivateSingleLinkRegularFile(descriptorAfter, expectedSize)
      || await digestDescriptor(file, expectedSize) !== expectedSha256) {
      throw new Error('The plugin source changed during the bounded read.');
    }
    return result;
  } finally {
    await file?.close().catch(() => {});
  }
}
