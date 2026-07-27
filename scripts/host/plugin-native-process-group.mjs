import { nativeBoundaryError } from './plugin-native-deadline.mjs';

const GROUP_POLL_INTERVAL_MS = 10;

export function signalNativeProcessGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error?.code !== 'ESRCH') throw error; }
}

export function nativeProcessGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

export function waitForNativeProcessGroupGone({
  pid,
  probeGroup = nativeProcessGroupExists,
  timeoutMs,
  signal,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof probeGroup !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Native process-group wait options are invalid.');
  }
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer = null;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, nativeBoundaryError(
      'PLUGIN_NATIVE_CANCELLED',
      'The native plugin operation was cancelled.',
      499,
      signal.reason,
    ));
    const check = () => {
      try {
        const exists = probeGroup(pid);
        if (typeof exists !== 'boolean') throw new TypeError('Native process-group probe must return a boolean.');
        if (!exists) return finish(resolve, true);
        const remaining = deadline - Date.now();
        if (remaining <= 0) return finish(reject, nativeBoundaryError(
          'PLUGIN_NATIVE_REAP_TIMEOUT',
          'The native plugin process group could not be reaped.',
          504,
        ));
        timer = setTimeout(check, Math.min(GROUP_POLL_INTERVAL_MS, remaining));
      } catch (error) {
        return finish(reject, nativeBoundaryError(
          'PLUGIN_NATIVE_REAP_FAILED',
          'The native plugin process group could not be inspected.',
          500,
          error,
        ));
      }
      return undefined;
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else check();
  });
}
