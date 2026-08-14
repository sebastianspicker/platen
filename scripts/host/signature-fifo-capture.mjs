import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  open,
  readdir,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HostError } from './host-error.mjs';
import { runProcess } from './process-runner.mjs';

const MKFIFO_EXECUTABLE = '/usr/bin/mkfifo';
const FIFO_READ_CHUNK_BYTES = 64 * 1024;
const FIFO_TOPOLOGY_INTERVAL_MS = 10;
const MAX_FIFO_COUNT = 100;
const DUMP_NAME = /^input\.pdf\.sig(?:0|[1-9]\d{0,2})$/;

function captureError(cause = undefined) {
  return new HostError(
    'SIGNATURE_DUMP_INVALID',
    'The isolated signature backend did not produce a complete bounded CMS inventory.',
    502,
    cause === undefined ? undefined : { cause },
  );
}

function checkedNames(names) {
  if (!Array.isArray(names) || names.length < 1 || names.length > MAX_FIFO_COUNT
    || names.some((name, index) => typeof name !== 'string' || !DUMP_NAME.test(name)
      || name !== `input.pdf.sig${index}`)
    || new Set(names).size !== names.length) throw new TypeError('names must be a fixed sequential signature dump inventory');
  return Object.freeze([...names]);
}

function checkedLimit(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function ownerUid() {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
}

async function assertDirectory(path, expectedMode) {
  const metadata = await lstat(path, { bigint: true });
  const uid = ownerUid();
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (metadata.mode & 0o777n) !== BigInt(expectedMode)
    || (uid !== null && metadata.uid !== uid)) throw captureError();
}

function isOwnedPrivateFifo(metadata) {
  const uid = ownerUid();
  return metadata.isFIFO() && !metadata.isSymbolicLink() && metadata.nlink === 1n
    && (metadata.mode & 0o777n) === 0o600n
    && (uid === null || metadata.uid === uid);
}

function sameFifo(metadata, identity) {
  return isOwnedPrivateFifo(metadata)
    && metadata.dev === identity.dev && metadata.ino === identity.ino;
}

async function assertFifo(path, identity = undefined) {
  const metadata = await lstat(path, { bigint: true });
  const checkedIdentity = identity ?? Object.freeze({ dev: metadata.dev, ino: metadata.ino });
  if (!sameFifo(metadata, checkedIdentity)) throw captureError();
  return checkedIdentity;
}

async function assertFrozenInventory(dumpDirectory, names, identities) {
  await assertDirectory(dumpDirectory, 0o500);
  const entries = await readdir(dumpDirectory, { withFileTypes: true });
  if (entries.length !== names.length) throw captureError();
  const expected = new Set(names);
  for (const entry of entries) {
    const index = names.indexOf(entry.name);
    if (index < 0 || !expected.has(entry.name) || !entry.isFIFO() || entry.isSymbolicLink()) {
      throw captureError();
    }
    await assertFifo(join(dumpDirectory, entry.name), identities[index]);
  }
}

async function createFifos(dumpDirectory, names, signal) {
  await runProcess({
    executable: MKFIFO_EXECUTABLE,
    args: ['-m', '600', ...names.map((name) => join(dumpDirectory, name))],
    cwd: dumpDirectory,
    signal,
    timeoutMs: 5_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 4_096,
  });
}

async function cleanupFifos(dumpDirectory, names, handles, identities) {
  let firstError = null;
  await chmod(dumpDirectory, 0o700).catch((error) => { firstError ??= error; });
  await Promise.all(handles.map((handle) => handle.close().catch((error) => { firstError ??= error; })));
  for (const [index, name] of names.entries()) {
    const path = join(dumpDirectory, name);
    try {
      const metadata = await lstat(path, { bigint: true });
      if (identities[index] ? sameFifo(metadata, identities[index]) : isOwnedPrivateFifo(metadata)) await unlink(path);
      else firstError ??= captureError();
    } catch (error) {
      if (error?.code !== 'ENOENT') firstError ??= error;
    }
  }
  return firstError;
}

async function prepareFifos(dumpDirectory, names, signal) {
  const handles = [];
  const identities = [];
  try {
    await assertDirectory(dumpDirectory, 0o700);
    if ((await readdir(dumpDirectory)).length !== 0) throw captureError();
    await createFifos(dumpDirectory, names, signal);
    for (const name of names) {
      const path = join(dumpDirectory, name);
      identities.push(await assertFifo(path));
    }
    for (const [index, name] of names.entries()) {
      const path = join(dumpDirectory, name);
      const identity = identities[index];
      const handle = await open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat({ bigint: true });
      if (!sameFifo(opened, identity)) {
        await handle.close().catch(() => {});
        throw captureError();
      }
      handles.push(handle);
    }
    await chmod(dumpDirectory, 0o500);
    await assertFrozenInventory(dumpDirectory, names, identities);
    return { handles, identities };
  } catch (error) {
    await cleanupFifos(dumpDirectory, names, handles, identities);
    throw error;
  }
}

async function readOne(handle, chunks, size, totalSize, perFileLimit, totalLimit) {
  const permitted = Math.min(perFileLimit - size, totalLimit - totalSize);
  const readLength = Math.min(FIFO_READ_CHUNK_BYTES, Math.max(1, permitted + 1));
  const scratch = Buffer.allocUnsafe(readLength);
  try {
    const { bytesRead } = await handle.read(scratch, 0, readLength, null);
    if (bytesRead === 0) return Object.freeze({ state: 'eof', bytesRead: 0 });
    if (bytesRead > permitted) return Object.freeze({ state: 'limit', bytesRead });
    chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    return Object.freeze({ state: 'data', bytesRead });
  } catch (error) {
    if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') {
      return Object.freeze({ state: 'waiting', bytesRead: 0 });
    }
    throw error;
  }
}

async function pumpFifos({
  dumpDirectory,
  names,
  handles,
  identities,
  chunks,
  sizes,
  executionState,
  fail,
  perFileLimit,
  totalLimit,
}) {
  let totalSize = 0;
  let lastTopologyCheck = 0;
  while (true) {
    const now = Date.now();
    if (now - lastTopologyCheck >= FIFO_TOPOLOGY_INTERVAL_MS) {
      try {
        await assertFrozenInventory(dumpDirectory, names, identities);
      } catch (error) {
        fail(error instanceof HostError ? error : captureError(error));
        return;
      }
      lastTopologyCheck = now;
    }

    let madeProgress = false;
    let allEof = executionState.done;
    for (const [index, handle] of handles.entries()) {
      let outcome;
      try {
        outcome = await readOne(
          handle,
          chunks[index],
          sizes[index],
          totalSize,
          perFileLimit,
          totalLimit,
        );
      } catch (error) {
        fail(captureError(error));
        return;
      }
      if (outcome.state === 'limit') {
        fail(captureError());
        return;
      }
      if (outcome.state === 'data') {
        sizes[index] += outcome.bytesRead;
        totalSize += outcome.bytesRead;
        madeProgress = true;
        allEof = false;
      } else if (outcome.state !== 'eof') {
        allEof = false;
      }
    }
    if (executionState.done && allEof) return;
    await delay(madeProgress ? 0 : 1);
  }
}

export async function captureBoundedSignatureFifos({
  dumpDirectory,
  names,
  signal,
  execute,
  maxBytesPerFile,
  maxBytesTotal,
} = {}) {
  if (typeof dumpDirectory !== 'string' || !dumpDirectory.startsWith('/') || dumpDirectory.includes('\0')) {
    throw new TypeError('dumpDirectory must be an absolute path without NUL bytes');
  }
  if (typeof execute !== 'function') throw new TypeError('execute must be a function');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  const checked = checkedNames(names);
  const perFileLimit = checkedLimit(maxBytesPerFile, 'maxBytesPerFile');
  const totalLimit = checkedLimit(maxBytesTotal, 'maxBytesTotal');
  const { handles, identities } = await prepareFifos(dumpDirectory, checked, signal);
  const chunks = checked.map(() => []);
  const sizes = checked.map(() => 0);
  const executionState = { done: false };
  const controller = new AbortController();
  const compositeSignal = signal === undefined
    ? controller.signal
    : AbortSignal.any([signal, controller.signal]);
  let captureFailure = null;
  const fail = (error) => {
    if (captureFailure !== null) return;
    captureFailure = error;
    controller.abort(error);
  };
  const pump = pumpFifos({
    dumpDirectory,
    names: checked,
    handles,
    identities,
    chunks,
    sizes,
    executionState,
    fail,
    perFileLimit,
    totalLimit,
  });

  let result;
  let executionError = null;
  try {
    result = await execute(compositeSignal);
  } catch (error) {
    executionError = error;
  } finally {
    executionState.done = true;
  }
  await pump;
  const cleanupError = await cleanupFifos(dumpDirectory, checked, handles, identities);
  if (captureFailure !== null) throw captureFailure;
  if (cleanupError !== null) throw captureError(cleanupError);
  if (executionError !== null) throw executionError;
  await assertDirectory(dumpDirectory, 0o700);
  if ((await readdir(dumpDirectory)).length !== 0) throw captureError();
  return Object.freeze({
    result,
    buffers: Object.freeze(chunks.map((parts, index) => Buffer.concat(parts, sizes[index]))),
  });
}

export async function promoteCapturedSignatureFiles({ dumpDirectory, names, buffers } = {}) {
  const checked = checkedNames(names);
  if (!Array.isArray(buffers) || buffers.length !== checked.length
    || buffers.some((buffer) => !Buffer.isBuffer(buffer))) throw new TypeError('buffers must match the signature inventory');
  await assertDirectory(dumpDirectory, 0o700);
  if ((await readdir(dumpDirectory)).length !== 0) throw captureError();
  for (const [index, name] of checked.entries()) {
    const path = join(dumpDirectory, name);
    let handle;
    try {
      handle = await open(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.chmod(0o600);
      await handle.writeFile(buffers[index]);
      await handle.sync();
      const metadata = await handle.stat({ bigint: true });
      const uid = ownerUid();
      if (!metadata.isFile() || metadata.nlink !== 1n
        || metadata.size !== BigInt(buffers[index].length)
        || (metadata.mode & 0o777n) !== 0o600n
        || (uid !== null && metadata.uid !== uid)) throw captureError();
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw captureError(error);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}
