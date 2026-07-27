import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from '../host-error.mjs';
import { cancelled, digestFile, fail } from './prepress-support.mjs';

function createJobControl(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const forward = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) forward();
  else externalSignal?.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Prepress job deadline exceeded'));
  }, timeoutMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    get timedOut() { return timedOut; },
    remainingMs: () => Math.max(1, timeoutMs - (Date.now() - startedAt)),
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', forward);
    },
  });
}

async function measureWorkspace(directory, maximumBytes, maximumFiles) {
  let bytes = 0;
  let files = 0;
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      let metadata;
      try {
        metadata = await lstat(target);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (metadata.isSymbolicLink()) {
        fail('PREPRESS_WORKSPACE_INVALID', 'Prepress workspace contains a symbolic link.', 502);
      }
      if (metadata.isDirectory()) await walk(target);
      else if (metadata.isFile() && metadata.nlink === 1) {
        bytes += metadata.size;
        files += 1;
      } else {
        fail('PREPRESS_WORKSPACE_INVALID', 'Prepress workspace contains a non-regular entry.', 502);
      }
      if (bytes > maximumBytes || files > maximumFiles) {
        fail('PREPRESS_WORKSPACE_LIMIT', 'Prepress processing exceeded its active workspace quota.', 413);
      }
    }
  }
  await walk(directory);
  return Object.freeze({ bytes, files });
}

function createWorkspaceMonitor(directory, control, limits) {
  let error = null;
  let active = null;
  const check = async () => {
    if (error) throw error;
    active ??= measureWorkspace(directory, limits.maxWorkspaceBytes, limits.maxWorkspaceFiles)
      .catch((caught) => {
        error = caught;
        control.abort(caught);
        throw caught;
      })
      .finally(() => { active = null; });
    return active;
  };
  const interval = setInterval(() => { void check().catch(() => {}); }, 50);
  interval.unref?.();
  return Object.freeze({
    check,
    get error() { return error; },
    stop() { clearInterval(interval); },
  });
}

/** Runs one source-bound job and always cleans its isolated workspace. */
export async function runBoundedPrepressJob(core, documentId, externalSignal, action) {
  const document = core.store.getDocument(documentId);
  cancelled(externalSignal);
  await core.store.verifySource(document.id);
  const control = createJobControl(externalSignal, core.limits.timeoutMs);
  const workspace = await core.store.createJobWorkspace(document.id);
  let monitor = null;
  let result;
  let failure = null;
  try {
    const sourcePath = join(workspace, 'source.pdf');
    await copyFile(core.store.getSourcePath(document.id), sourcePath, fsConstants.COPYFILE_EXCL);
    await chmod(sourcePath, 0o400);
    if (await digestFile(sourcePath) !== document.sha256) {
      fail('SOURCE_INTEGRITY_FAILED', 'The private prepress source copy did not match the immutable document.', 500);
    }
    monitor = createWorkspaceMonitor(workspace, control, core.limits);
    await monitor.check();
    const info = await core.pdf.inspect(document.id, { signal: control.signal });
    if (!Number.isSafeInteger(info?.pageCount) || info.pageCount < 1) {
      fail('INVALID_ENGINE_OUTPUT', 'PDF inspection did not return a valid page count.', 502);
    }
    result = await action({
      document,
      sourcePath,
      info,
      workspace,
      signal: control.signal,
      runOptions: () => ({ signal: control.signal, timeoutMs: control.remainingMs() }),
      checkWorkspace: () => monitor.check(),
    });
    await monitor.check();
    cancelled(control.signal);
    await core.store.verifySource(document.id);
  } catch (error) {
    failure = monitor?.error ?? (control.timedOut
      ? new HostError('PREPRESS_JOB_TIMEOUT', 'The local prepress operation exceeded its whole-job deadline.', 504, { cause: error })
      : externalSignal?.aborted
        ? new HostError('JOB_CANCELLED', 'The local prepress operation was cancelled.', 499, { cause: error })
        : error);
  } finally {
    monitor?.stop();
    control.dispose();
    try {
      await core.store.cleanupJob(workspace);
    } catch (error) {
      if (!failure) {
        failure = new HostError('PREPRESS_CLEANUP_FAILED', 'The private prepress workspace could not be removed.', 500, { cause: error });
      }
    }
  }
  if (failure) throw failure;
  return result;
}
