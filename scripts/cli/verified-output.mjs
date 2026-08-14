import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_VERIFIED_OUTPUT_BYTES = 256 * 1024 * 1024;
const OUTPUT_VERIFICATION_FAILED = 'CLI_OUTPUT_VERIFICATION_FAILED';
const OUTPUT_CLEANUP_FAILED = 'CLI_OUTPUT_CLEANUP_FAILED';

function verificationFailure(fail) {
  fail(OUTPUT_VERIFICATION_FAILED, 'The published output could not be verified safely.');
}

function isStableRegularFile(metadata, identity, size) {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && (metadata.mode & 0o777) === 0o600
    && metadata.size === size
    && metadata.dev === identity.dev
    && metadata.ino === identity.ino;
}

function sameMetadata(first, second) {
  return first.isFile() === second.isFile()
    && first.isSymbolicLink() === second.isSymbolicLink()
    && first.nlink === second.nlink
    && (first.mode & 0o777) === (second.mode & 0o777)
    && first.size === second.size
    && first.dev === second.dev
    && first.ino === second.ino
    && first.mtimeNs === second.mtimeNs
    && first.ctimeNs === second.ctimeNs;
}

async function removeVerifiedPublishedTarget(target, identity, { fail, syncDirectory }) {
  const metadata = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    fail(OUTPUT_CLEANUP_FAILED, 'The published output could not be removed safely.');
  });
  if (!metadata) return;
  if (!isStableRegularFile(metadata, identity, metadata.size)) {
    fail(OUTPUT_CLEANUP_FAILED, 'The published output could not be removed safely.');
  }
  try {
    await rm(target);
    await syncDirectory(dirname(target));
  } catch {
    fail(OUTPUT_CLEANUP_FAILED, 'The published output could not be removed safely.');
  }
}

async function readVerifiedTarget(target, identity, bytes, signal, dependencies) {
  const { cancelled, fail } = dependencies;
  const expectedDigest = createHash('sha256').update(bytes).digest('hex');
  let handle;
  try {
    cancelled(signal);
    const pathBefore = await lstat(target);
    if (!isStableRegularFile(pathBefore, identity, bytes.length)) verificationFailure(fail);
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const fdBefore = await handle.stat();
    if (!isStableRegularFile(fdBefore, identity, bytes.length)) verificationFailure(fail);
    if (!sameMetadata(pathBefore, fdBefore)) verificationFailure(fail);

    const actual = Buffer.alloc(bytes.length);
    let offset = 0;
    while (offset < actual.length) {
      cancelled(signal);
      const { bytesRead } = await handle.read(
        actual, offset, Math.min(1024 * 1024, actual.length - offset), offset,
      );
      if (bytesRead < 1) verificationFailure(fail);
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, offset)).bytesRead !== 0) verificationFailure(fail);
    const fdAfter = await handle.stat();
    const pathAfter = await lstat(target);
    if (!isStableRegularFile(fdAfter, identity, bytes.length)
      || !sameMetadata(fdBefore, fdAfter)
      || !isStableRegularFile(pathAfter, identity, bytes.length)
      || !sameMetadata(fdAfter, pathAfter)) verificationFailure(fail);
    const actualDigest = createHash('sha256').update(actual).digest('hex');
    if (actualDigest !== expectedDigest || !actual.equals(bytes)) verificationFailure(fail);
    cancelled(signal);
    return Object.freeze({ size: actual.length, sha256: actualDigest });
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED' || error?.code === OUTPUT_VERIFICATION_FAILED) throw error;
    verificationFailure(fail);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function createVerifiedWriter(dependencies) {
  const {
    canonicalOutputTarget, cancelled, fail, temporaryOutputPath, publishTemporary, syncDirectory,
    sanitizeOutputError,
  } = dependencies;
  return async function writeExclusiveVerified(outputPath, bytes, signal, finalize) {
    if (finalize !== undefined && typeof finalize !== 'function') {
      throw new TypeError('Output finalizer must be a function when provided.');
    }
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_VERIFIED_OUTPUT_BYTES) {
      fail(OUTPUT_VERIFICATION_FAILED, 'The published output could not be verified safely.');
    }
    const target = await canonicalOutputTarget(outputPath);
    cancelled(signal);
    const temp = temporaryOutputPath(target);
    let handle;
    let identity = null;
    let finalizeStarted = false;
    try {
      handle = await open(temp, 'wx', 0o600);
      cancelled(signal);
      await handle.writeFile(bytes);
      cancelled(signal);
      await handle.sync();
      await handle.close();
      handle = null;
      cancelled(signal);
      identity = await publishTemporary(temp, target, signal);
      const receipt = await readVerifiedTarget(target, identity, bytes, signal, { cancelled, fail });
      if (finalize) {
        finalizeStarted = true;
        await finalize(receipt);
      }
      identity = null;
      return receipt;
    } catch (error) {
      const hadPublishedIdentity = Boolean(identity);
      if (identity) {
        try {
          await removeVerifiedPublishedTarget(target, identity, { fail, syncDirectory });
        } catch (cleanupError) {
          throw cleanupError;
        }
        identity = null;
      }
      if (error?.code === 'JOB_CANCELLED') throw error;
      if (error?.code === OUTPUT_VERIFICATION_FAILED) throw error;
      if (error?.code === OUTPUT_CLEANUP_FAILED) throw error;
      if (finalizeStarted) throw error;
      if (!hadPublishedIdentity && typeof sanitizeOutputError === 'function') {
        sanitizeOutputError(error);
      }
      fail(OUTPUT_VERIFICATION_FAILED, 'The published output could not be verified safely.');
    } finally {
      await handle?.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
    }
  };
}
