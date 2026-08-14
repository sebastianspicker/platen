import { HostError } from './host-error.mjs';

export function nativeBoundaryError(code, message, status = 502, cause) {
  return new HostError(code, message, status, cause === undefined ? {} : { cause });
}

export function waitNativeBoundary(promise, { timeoutMs, signal, code, message }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, nativeBoundaryError(
      'PLUGIN_NATIVE_CANCELLED',
      'The native plugin operation was cancelled.',
      499,
      signal.reason,
    ));
    const timer = setTimeout(
      () => finish(reject, nativeBoundaryError(code, message, 504)),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}
