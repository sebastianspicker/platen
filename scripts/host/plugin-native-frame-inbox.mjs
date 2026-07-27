import { HostError } from './host-error.mjs';
import { PluginFrameParser } from './plugin-frame-stream.mjs';
import { NATIVE_PLUGIN_PROTOCOL_LIMITS } from './plugin-native-supervisor-contract.mjs';
import { nativeBoundaryError, waitNativeBoundary } from './plugin-native-deadline.mjs';

export const MAX_NATIVE_FRAMES = 2;
export const MAX_NATIVE_STDOUT_BYTES = MAX_NATIVE_FRAMES
  * (NATIVE_PLUGIN_PROTOCOL_LIMITS.maxFrameBytes + 4);

export class NativeFrameInbox {
  #frames = [];
  #waiters = [];
  #frameCount = 0;
  #terminal = null;
  #doneResolve;
  #doneReject;
  #done;
  #readable;
  #phase = 'preparation';
  #deliveredFrames = 0;

  constructor(readable) {
    if (!readable || typeof readable[Symbol.asyncIterator] !== 'function'
      || typeof readable.destroy !== 'function') {
      throw new TypeError('Native supervisor stdout must be a destroyable async-readable stream.');
    }
    this.#readable = readable;
    this.#done = new Promise((resolve, reject) => {
      this.#doneResolve = resolve;
      this.#doneReject = reject;
    });
    this.#done.catch(() => {});
    void this.#pump();
  }

  async #pump() {
    const parser = new PluginFrameParser({
      limits: {
        maxFrameBytes: NATIVE_PLUGIN_PROTOCOL_LIMITS.maxFrameBytes,
        maxCumulativeBytes: MAX_NATIVE_STDOUT_BYTES,
      },
      onFrame: (frame) => this.#accept(frame),
    });
    try {
      for await (const chunk of this.#readable) await parser.push(chunk);
      parser.finish();
      this.#terminal = Object.freeze({ kind: 'eof' });
      this.#rejectWaiters(nativeBoundaryError(
        'PLUGIN_NATIVE_PROTOCOL_EOF',
        'The native plugin process ended before its next protocol frame.',
      ));
      this.#doneResolve(Object.freeze({
        frameCount: this.#frameCount,
        receivedBytes: parser.receivedBytes,
      }));
    } catch (error) {
      const failure = error instanceof HostError ? error : nativeBoundaryError(
        'PLUGIN_NATIVE_PROTOCOL_INVALID',
        'The native plugin process returned an invalid protocol stream.',
        502,
        error,
      );
      this.#terminal = Object.freeze({ kind: 'error', error: failure });
      this.#rejectWaiters(failure);
      this.#doneReject(failure);
      if (!this.#readable.destroyed) this.#readable.destroy();
    }
  }

  #accept(frame) {
    this.#frameCount += 1;
    if (this.#frameCount > MAX_NATIVE_FRAMES) {
      throw nativeBoundaryError(
        'PLUGIN_NATIVE_PROTOCOL_INVALID',
        'The native plugin process returned too many frames.',
      );
    }
    if (this.#frameCount === 2 && this.#phase !== 'invocation') {
      throw nativeBoundaryError(
        'PLUGIN_NATIVE_PROTOCOL_PHASE',
        'The native plugin process returned completion before invocation began.',
      );
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      this.#deliveredFrames += 1;
      waiter.resolve(frame);
    }
    else this.#frames.push(frame);
  }

  #rejectWaiters(error) {
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  next({ timeoutMs, signal, phase }) {
    const frame = this.#frames.shift();
    if (frame) {
      this.#deliveredFrames += 1;
      return Promise.resolve(frame);
    }
    if (this.#terminal?.kind === 'error') return Promise.reject(this.#terminal.error);
    if (this.#terminal?.kind === 'eof') {
      return Promise.reject(nativeBoundaryError(
        'PLUGIN_NATIVE_PROTOCOL_EOF',
        `The native plugin process ended before ${phase}.`,
      ));
    }
    let waiter;
    const pending = new Promise((resolve, reject) => {
      waiter = { resolve, reject };
      this.#waiters.push(waiter);
    });
    return waitNativeBoundary(pending, {
      timeoutMs,
      signal,
      code: 'PLUGIN_NATIVE_PROTOCOL_TIMEOUT',
      message: `The native plugin process did not return ${phase} in time.`,
    }).finally(() => {
      const index = this.#waiters.indexOf(waiter);
      if (index >= 0) this.#waiters.splice(index, 1);
    });
  }

  assertReadyOnly() {
    if (this.#terminal?.kind === 'error') throw this.#terminal.error;
    if (this.#terminal?.kind === 'eof') {
      throw nativeBoundaryError(
        'PLUGIN_NATIVE_PROTOCOL_EOF',
        'The native plugin process ended after its ready attestation.',
      );
    }
    if (this.#phase !== 'preparation' || this.#frameCount !== 1 || this.#deliveredFrames !== 1) {
      throw nativeBoundaryError(
        'PLUGIN_NATIVE_PROTOCOL_PHASE',
        'The native plugin process did not stop at its ready attestation.',
      );
    }
  }

  beginInvocation() {
    this.assertReadyOnly();
    this.#phase = 'invocation';
  }

  done({ timeoutMs, signal }) {
    return waitNativeBoundary(this.#done, {
      timeoutMs,
      signal,
      code: 'PLUGIN_NATIVE_EXIT_TIMEOUT',
      message: 'The native plugin protocol stream did not close in time.',
    });
  }

  abort() {
    if (!this.#readable.destroyed) this.#readable.destroy();
  }
}
