function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function createBoundedProcessLimiter({
  runner,
  concurrency = 4,
  maximumQueued = 24,
  cancelledError,
  queueFullError,
  hostUnhealthyError,
} = {}) {
  if (typeof runner !== 'function') throw new TypeError('runner must be a function');
  if (typeof cancelledError !== 'function' || typeof queueFullError !== 'function' || typeof hostUnhealthyError !== 'function') {
    throw new TypeError('limiter error factories must be callable');
  }
  positiveInteger(concurrency, 'concurrency');
  positiveInteger(maximumQueued, 'maximumQueued');
  let active = 0;
  let quarantined = 0;
  const queue = [];

  function failStrandedQueue() {
    if (quarantined < concurrency) return;
    while (queue.length) {
      const entry = queue.shift();
      entry.cleanup();
      entry.reject(hostUnhealthyError());
    }
  }

  function drain() {
    while (active < concurrency && queue.length) {
      const { invocation, resolve, reject, cleanup } = queue.shift();
      cleanup();
      active += 1;
      Promise.resolve()
        .then(() => runner(invocation))
        .then((value) => {
          active -= 1;
          resolve(value);
          drain();
        }, (error) => {
          reject(error);
          if (error?.code === 'ENGINE_REAP_TIMEOUT') {
            quarantined += 1;
            failStrandedQueue();
            return;
          }
          active -= 1;
          drain();
        });
    }
  }

  return function limitedRun(invocation = {}) {
    if (quarantined >= concurrency) return Promise.reject(hostUnhealthyError());
    if (active >= concurrency && queue.length >= maximumQueued) {
      return Promise.reject(queueFullError(invocation.executable, invocation.args, maximumQueued));
    }
    return new Promise((resolve, reject) => {
      const signal = invocation.signal;
      if (signal?.aborted) {
        reject(cancelledError(invocation.executable, invocation.args, signal.reason));
        return;
      }
      let entry;
      const onAbort = () => {
        const index = queue.indexOf(entry);
        if (index === -1) return;
        queue.splice(index, 1);
        entry.cleanup();
        reject(cancelledError(invocation.executable, invocation.args, signal.reason));
        drain();
      };
      entry = {
        invocation,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(entry);
      drain();
    });
  };
}
