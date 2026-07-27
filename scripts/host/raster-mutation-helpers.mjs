import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import { MAX_RASTER_JOB_MS } from './raster-mutation-contract.mjs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

function sameFileIdentity(left, right) {
  return ['dev', 'ino', 'size'].every((key) => left[key] === right[key]);
}

function unchangedDuringRead(before, after, byteLength) {
  return byteLength === before.size
    && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => before[key] === after[key]);
}

export async function workspaceBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = await lstat(join(directory, entry.name));
    if (file.isFile()) total += file.size;
  }
  return total;
}

export async function assertPng(filePath) {
  const file = await stat(filePath).catch(() => null);
  if (!file?.isFile() || file.size < PNG_SIGNATURE.length || file.size > 64 * 1024 * 1024) {
    fail('INVALID_ENGINE_OUTPUT', 'The local renderer did not produce a bounded PNG.', 502);
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !sameFileIdentity(before, file)) {
      fail('INVALID_ENGINE_OUTPUT', 'The local renderer output changed before PNG validation.', 502);
    }

    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!unchangedDuringRead(before, after, bytes.length)) {
      fail('INVALID_ENGINE_OUTPUT', 'The local renderer output changed during PNG validation.', 502);
    }
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      fail('INVALID_ENGINE_OUTPUT', 'The local renderer output is not a PNG.', 502);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export function jobSignal(externalSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const forward = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) forward();
  else externalSignal?.addEventListener('abort', forward, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Raster mutation deadline exceeded'));
  }, MAX_RASTER_JOB_MS);
  timer.unref?.();

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', forward);
    },
  };
}
