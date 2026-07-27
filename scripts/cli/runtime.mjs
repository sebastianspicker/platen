import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import {
  emit, emitCompact, outputValue as emitOutputValue, safeBatchStem, waitFor as waitForSignal,
} from './runtime-emission.mjs';

export { emit, emitCompact, safeBatchStem };

const MAX_PATH_LENGTH = 4_096;

export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function cancelled(signal) {
  if (signal?.aborted) {
    fail('JOB_CANCELLED', 'The local CLI operation was cancelled.');
  }
}

export async function* abortableStream(stream, signal) {
  for await (const chunk of stream) {
    cancelled(signal);
    yield chunk;
  }
}

function boundedPath(value, label) {
  const invalid = typeof value !== 'string'
    || !value
    || value.length > MAX_PATH_LENGTH
    || value.includes('\0');
  if (invalid) {
    fail(
      'CLI_INVALID_PATH',
      `${label} must be a non-empty local path within ${MAX_PATH_LENGTH} characters.`,
    );
  }
  return value;
}

function unchangedFile(initial, final) {
  return final.size === initial.size
    && final.mtimeMs === initial.mtimeMs
    && final.ctimeMs === initial.ctimeMs;
}

function throwSanitizedOutputError(error) {
  if (error?.code === 'JOB_CANCELLED' || error?.code?.startsWith?.('CLI_')) {
    throw error;
  }
  if (typeof error?.path === 'string' || typeof error?.dest === 'string'
    || typeof error?.syscall === 'string') {
    fail(
      'CLI_OUTPUT_FAILED',
      'The output could not be published to the requested local path.',
    );
  }
  throw error;
}

function throwSanitizedInputError(error) {
  if (error?.code === 'JOB_CANCELLED' || error?.code?.startsWith?.('CLI_')) {
    throw error;
  }
  if (typeof error?.path === 'string' || typeof error?.dest === 'string'
    || typeof error?.syscall === 'string') {
    fail(
      'CLI_INVALID_INPUT',
      'The selected local input could not be opened safely.',
    );
  }
  throw error;
}

export async function readLocalInputBytes(inputPath, {
  minimumBytes = 1,
  maximumBytes,
  extension,
  signal,
} = {}) {
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 1
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < minimumBytes
    || maximumBytes > 256 * 1024 * 1024
    || (extension !== undefined && (!/^\.[a-z0-9]{1,16}$/u.test(extension)
      || extension !== extension.toLowerCase()))) {
    throw new TypeError('Local input byte bounds or extension are invalid.');
  }
  const resolvedInput = resolve(boundedPath(inputPath, 'Input'));
  if (extension && extname(resolvedInput).toLowerCase() !== extension) {
    fail('CLI_INVALID_INPUT', `The selected local input must use the ${extension} extension.`);
  }
  let handle;
  try {
    cancelled(signal);
    const pathMetadata = await lstat(resolvedInput);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()
      || pathMetadata.nlink !== 1 || pathMetadata.size < minimumBytes
      || pathMetadata.size > maximumBytes) {
      fail(
        'CLI_INVALID_INPUT',
        'The selected input must be a bounded single-link regular file.',
      );
    }
    handle = await open(
      resolvedInput,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1
      || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino
      || before.size !== pathMetadata.size) {
      fail('CLI_INPUT_CHANGED', 'The selected local input changed before it could be read.');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      cancelled(signal);
      const { bytesRead } = await handle.read(
        bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset,
      );
      if (bytesRead < 1) {
        fail('CLI_INPUT_CHANGED', 'The selected local input ended while it was being read.');
      }
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, offset)).bytesRead !== 0) {
      fail('CLI_INPUT_CHANGED', 'The selected local input grew while it was being read.');
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.nlink !== before.nlink || !unchangedFile(before, after)) {
      fail('CLI_INPUT_CHANGED', 'The selected local input changed while it was being read.');
    }
    cancelled(signal);
    return Object.freeze({ bytes, displayName: basename(resolvedInput) });
  } catch (error) {
    throwSanitizedInputError(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function uploadPdf(application, inputPath, signal) {
  const resolvedInput = resolve(inputPath);
  let handle;
  let stream;
  try {
    cancelled(signal);
    const pathMetadata = await lstat(resolvedInput);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()
      || pathMetadata.nlink !== 1) {
      fail('CLI_INVALID_INPUT', 'Each input must be a single-link regular PDF file.');
    }

    handle = await open(
      resolvedInput,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.dev !== pathMetadata.dev
      || metadata.ino !== pathMetadata.ino
    ) {
      fail('CLI_INVALID_INPUT', 'The PDF input changed before it could be copied privately.');
    }

    stream = handle.createReadStream({ autoClose: false });
    const document = await application.store.createDocument({
      stream: abortableStream(stream, signal),
      displayName: basename(resolvedInput),
      mediaType: 'application/pdf',
    });
    const finalMetadata = await handle.stat();
    if (!unchangedFile(metadata, finalMetadata)) {
      if (typeof application.store.deleteDocument === 'function') {
        await application.store.deleteDocument(document.id).catch(() => {});
      }
      fail('CLI_INPUT_CHANGED', 'The PDF input changed while it was being copied privately.');
    }
    return document;
  } catch (error) {
    if (error?.code === 'ELOOP') {
      fail(
        'CLI_INVALID_INPUT',
        'Symbolic-link PDF inputs are not accepted by local CLI commands.',
      );
    }
    throwSanitizedInputError(error);
  } finally {
    stream?.destroy();
    await handle?.close().catch(() => {});
  }
}

async function existingPath(path) {
  return lstat(path).catch((error) => (
    error?.code === 'ENOENT' ? null : Promise.reject(error)
  ));
}

async function canonicalOutputParent(requested, errorMessage) {
  const parent = dirname(requested);
  const parentMetadata = await lstat(parent).catch(() => null);
  if (!parentMetadata?.isDirectory() || parentMetadata.isSymbolicLink()) {
    fail('CLI_INVALID_OUTPUT', errorMessage);
  }
  try {
    return await realpath(parent);
  } catch {
    fail('CLI_INVALID_OUTPUT', errorMessage);
  }
}

export async function canonicalOutputTarget(outputPath) {
  try {
    const requested = resolve(boundedPath(outputPath, 'Output'));
    const canonicalParent = await canonicalOutputParent(
      requested,
      'The output parent must be an existing non-symlink directory.',
    );
    const target = join(canonicalParent, basename(requested));
    if (await existingPath(target)) {
      fail(
        'CLI_OUTPUT_EXISTS',
        `Refusing to overwrite existing output: ${basename(target)}.`,
      );
    }
    return target;
  } catch (error) {
    throwSanitizedOutputError(error);
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // The file itself is already durable when directory fsync is unavailable.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function pathsOverlap(first, second) {
  return first === second
    || first.startsWith(`${second}${sep}`)
    || second.startsWith(`${first}${sep}`);
}

export async function createExclusiveOutputDirectory(
  outputPath,
  { disallowOverlapWith = [] } = {},
) {
  const requested = resolve(boundedPath(outputPath, 'Output directory'));
  const canonicalParent = await canonicalOutputParent(
    requested,
    'The batch output parent must be an existing non-symlink directory.',
  );
  const target = join(canonicalParent, basename(requested));
  for (const rootPath of disallowOverlapWith) {
    if (pathsOverlap(target, rootPath)) {
      fail('CLI_INVALID_OUTPUT', 'Input and output directories must not overlap.');
    }
  }
  if (await existingPath(target)) {
    fail('CLI_OUTPUT_EXISTS', 'The batch output directory must not already exist.');
  }

  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail('CLI_OUTPUT_EXISTS', 'The batch output directory must not already exist.');
    }
    throw error;
  }
  await syncDirectory(canonicalParent);
  return target;
}

async function removePublishedTarget(target, identity) {
  const targetMetadata = await lstat(target).catch((error) => (
    error?.code === 'ENOENT' ? null : Promise.reject(error)
  ));
  if (!targetMetadata) return;
  if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()
    || targetMetadata.dev !== identity.dev || targetMetadata.ino !== identity.ino) {
    fail(
      'CLI_OUTPUT_CLEANUP_FAILED',
      'Cancelled output could not be removed because its path identity changed.',
    );
  }
  await rm(target);
  await syncDirectory(dirname(target));
}

async function publishTemporary(temp, target, signal) {
  const identity = await lstat(temp);
  let linked = false;
  let operationError = null;
  try {
    cancelled(signal);
    await link(temp, target);
    linked = true;
    await syncDirectory(dirname(target));
  } catch (error) {
    operationError = error;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  if (linked && signal?.aborted) {
    await removePublishedTarget(target, identity);
    cancelled(signal);
  }
  if (operationError?.code === 'EEXIST') {
    fail(
      'CLI_OUTPUT_EXISTS',
      `Refusing to overwrite existing output: ${basename(target)}.`,
    );
  }
  if (operationError) throw operationError;
  cancelled(signal);
  return identity;
}

function temporaryOutputPath(target) {
  return join(dirname(target), `.platen-${randomUUID()}.partial`);
}

export async function writeExclusive(outputPath, bytes, signal) {
  const target = await canonicalOutputTarget(outputPath);
  cancelled(signal);
  const temp = temporaryOutputPath(target);
  let handle;
  let published = false;
  try {
    handle = await open(temp, 'wx', 0o600);
    cancelled(signal);
    await handle.writeFile(bytes);
    cancelled(signal);
    await handle.sync();
    await handle.close();
    handle = null;
    cancelled(signal);
    const identity = await publishTemporary(temp, target, signal);
    published = true;
    if (signal?.aborted) {
      await removePublishedTarget(target, identity);
      published = false;
      cancelled(signal);
    }
  } catch (error) {
    throwSanitizedOutputError(error);
  } finally {
    await handle?.close().catch(() => {});
    if (!published) await rm(temp, { force: true }).catch(() => {});
  }
  return target;
}

export async function copyExclusive(sourcePath, outputPath, signal) {
  const target = await canonicalOutputTarget(outputPath); const temp = temporaryOutputPath(target);
  try {
    cancelled(signal);
    await copyFile(sourcePath, temp, fsConstants.COPYFILE_EXCL);
    cancelled(signal);
    await chmod(temp, 0o600);
    let handle;
    try {
      handle = await open(temp, 'r');
      await handle.sync();
    } finally {
      await handle?.close().catch(() => {});
    }
    await publishTemporary(temp, target, signal);
  } catch (error) {
    throwSanitizedOutputError(error);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return target;
}

export async function waitFor(milliseconds, signal) {
  return waitForSignal(milliseconds, signal, cancelled);
}

export async function outputValue(command, stream, value, signal) {
  return emitOutputValue(command, stream, value, signal, { cancelled, writeExclusive });
}
