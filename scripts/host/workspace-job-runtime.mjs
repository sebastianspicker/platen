import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from './host-error.mjs';
import {
  MAX_JOB_WORKSPACE_BYTES,
  MAX_JOB_WORKSPACE_DEPTH,
  MAX_JOB_WORKSPACE_FILES,
} from './pdf-service-limits.mjs';

export async function measureWorkspaceBytes(directory) {
  let total = 0;
  let files = 0;
  async function walk(current, depth) {
    if (depth > MAX_JOB_WORKSPACE_DEPTH) {
      throw new HostError(
        'JOB_WORKSPACE_INVALID',
        'Local processing created an excessively deep workspace tree.',
        502,
      );
    }
    const entries = await readdir(current, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const target = join(current, entry.name);
      const record = await lstat(target).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!record) continue;
      if (record.isSymbolicLink()) {
        throw new HostError(
          'JOB_WORKSPACE_INVALID',
          'Local processing created a symbolic link in its private workspace.',
          502,
        );
      }
      if (record.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      if (!record.isFile() || record.nlink !== 1) {
        throw new HostError(
          'JOB_WORKSPACE_INVALID',
          'Local processing created a non-regular or multi-link workspace entry.',
          502,
        );
      }
      files += 1;
      total += record.size;
      if (files > MAX_JOB_WORKSPACE_FILES) {
        throw new HostError(
          'JOB_WORKSPACE_LIMIT',
          `Local processing exceeded its ${MAX_JOB_WORKSPACE_FILES}-file workspace quota.`,
          413,
        );
      }
    }
  }
  await walk(directory, 0);
  return total;
}

export async function assertWorkspaceQuota(
  directory,
  maximumBytes = MAX_JOB_WORKSPACE_BYTES,
) {
  const bytes = await measureWorkspaceBytes(directory);
  if (bytes > maximumBytes) {
    throw new HostError(
      'JOB_WORKSPACE_LIMIT',
      `Local processing exceeded its ${maximumBytes}-byte workspace quota.`,
      413,
    );
  }
  return bytes;
}

export function createWorkspaceQuotaMonitor(directory, deadline) {
  let quotaError = null;
  let checking = null;
  const check = async () => {
    if (quotaError) throw quotaError;
    checking ??= assertWorkspaceQuota(directory)
      .catch((error) => {
        quotaError = error;
        deadline.abort(error);
        throw error;
      })
      .finally(() => { checking = null; });
    return checking;
  };
  const interval = setInterval(() => { void check().catch(() => {}); }, 100);
  interval.unref?.();
  return Object.freeze({
    check,
    get error() { return quotaError; },
    stop() { clearInterval(interval); },
  });
}

export function createDeadline(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) forwardAbort();
  else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Local job deadline exceeded'));
  }, timeoutMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    get timedOut() { return timedOut; },
    abort(reason) { controller.abort(reason); },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', forwardAbort);
    },
  });
}
