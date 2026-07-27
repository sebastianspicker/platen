import { HostError } from './host-error.mjs';

export const DEFAULT_PLUGIN_FRAME_STREAM_LIMITS = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxCumulativeBytes: 4 * 1024 * 1024,
});

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

function normalizeLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Plugin frame stream limits must be an object.');
  }
  const limits = { ...DEFAULT_PLUGIN_FRAME_STREAM_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('Plugin frame stream limits must contain supported positive integers.');
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}

function bytes(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be bytes.`);
  }
  return Buffer.from(value);
}

function assertFrame(frame, maxFrameBytes) {
  const value = bytes(frame, 'Plugin frame');
  if (value.length < 4) fail('PLUGIN_FRAME_TRUNCATED', 'Plugin frame header is truncated.');
  const length = value.readUInt32BE(0);
  if (length > maxFrameBytes) fail('PLUGIN_FRAME_TOO_LARGE', 'Plugin frame prefix exceeds the byte limit.', 413);
  if (value.length !== length + 4) fail('PLUGIN_FRAME_TRUNCATED', 'Plugin frame length does not match its prefix.');
  return value;
}

/**
 * Incrementally extracts complete length-prefixed frames. It intentionally does
 * not decode UTF-8 or JSON: callers pass the returned bytes to the RPC broker,
 * which owns those validation errors.
 */
export class PluginFrameParser {
  #limits;
  #onFrame;
  #prefix = Buffer.allocUnsafe(4);
  #prefixLength = 0;
  #body = null;
  #bodyLength = 0;
  #receivedBytes = 0;
  #closed = false;
  #processing = false;

  constructor({ limits, onFrame }) {
    this.#limits = normalizeLimits(limits);
    if (typeof onFrame !== 'function') throw new TypeError('PluginFrameParser requires an onFrame callback.');
    this.#onFrame = onFrame;
  }

  get closed() { return this.#closed; }
  get receivedBytes() { return this.#receivedBytes; }
  get bufferedBytes() { return this.#body === null ? this.#prefixLength : this.#bodyLength; }
  get maxBufferedBytes() { return this.#limits.maxFrameBytes + 4; }

  async push(chunk) {
    if (this.#closed) fail('PLUGIN_FRAME_INPUT_CLOSED', 'Plugin frame input is closed.', 410);
    if (this.#processing) fail('PLUGIN_FRAME_INPUT_BUSY', 'Plugin frame input must be consumed serially.', 429);
    const input = bytes(chunk, 'Plugin frame stream chunk');
    if (input.length > this.#limits.maxCumulativeBytes - this.#receivedBytes) {
      this.abort();
      fail('PLUGIN_FRAME_CUMULATIVE_LIMIT', 'Plugin frame stream exceeds the cumulative byte limit.', 413);
    }
    this.#processing = true;
    try {
      this.#receivedBytes += input.length;
      let offset = 0;
      while (offset < input.length) {
        if (this.#body === null) {
          const count = Math.min(4 - this.#prefixLength, input.length - offset);
          input.copy(this.#prefix, this.#prefixLength, offset, offset + count);
          this.#prefixLength += count;
          offset += count;
          if (this.#prefixLength !== 4) continue;
          const declaredLength = this.#prefix.readUInt32BE(0);
          if (declaredLength > this.#limits.maxFrameBytes) {
            this.abort();
            fail('PLUGIN_FRAME_TOO_LARGE', 'Plugin frame prefix exceeds the byte limit.', 413);
          }
          this.#body = Buffer.allocUnsafe(declaredLength + 4);
          this.#prefix.copy(this.#body, 0);
          this.#prefixLength = 0;
          this.#bodyLength = 4;
          if (declaredLength === 0) {
            await this.#emitFrame();
            if (this.#closed) fail('PLUGIN_FRAME_INPUT_CLOSED', 'Plugin frame input is closed.', 410);
          }
          continue;
        }
        const count = Math.min(this.#body.length - this.#bodyLength, input.length - offset);
        input.copy(this.#body, this.#bodyLength, offset, offset + count);
        this.#bodyLength += count;
        offset += count;
        if (this.#bodyLength === this.#body.length) {
          await this.#emitFrame();
          if (this.#closed) fail('PLUGIN_FRAME_INPUT_CLOSED', 'Plugin frame input is closed.', 410);
        }
      }
    } catch (error) {
      this.abort();
      throw error;
    } finally {
      this.#processing = false;
    }
  }

  async #emitFrame() {
    const frame = this.#body;
    this.#prefixLength = 0;
    this.#body = null;
    this.#bodyLength = 0;
    await this.#onFrame(frame);
  }

  finish() {
    if (this.#closed) return false;
    this.#closed = true;
    if (this.#prefixLength !== 0 || this.#body !== null) {
      fail('PLUGIN_FRAME_TRUNCATED', 'Plugin frame stream ended before a complete frame arrived.');
    }
    return true;
  }

  close() { return this.finish(); }

  abort() {
    if (this.#closed) return false;
    this.#closed = true;
    this.#prefixLength = 0;
    this.#body = null;
    this.#bodyLength = 0;
    return true;
  }

  cancel() { return this.abort(); }
}

function waitForDrain(writable) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      writable.off('drain', onDrain);
      writable.off('error', onError);
      writable.off('close', onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new HostError('PLUGIN_FRAME_OUTPUT_CLOSED', 'Plugin frame output closed before draining.', 410)); };
    writable.once('drain', onDrain);
    writable.once('error', onError);
    writable.once('close', onClose);
  });
}

function endWritable(writable) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const canObserve = typeof writable.once === 'function' && typeof writable.off === 'function';
    const cleanup = () => {
      if (!canObserve) return;
      writable.off('error', onError);
      writable.off('close', onClose);
    };
    const settle = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => settle(error);
    const onClose = () => settle(new HostError(
      'PLUGIN_FRAME_OUTPUT_CLOSED',
      'Plugin frame output closed before finishing.',
      410,
    ));
    if (canObserve) {
      writable.once('error', onError);
      writable.once('close', onClose);
    }
    try { writable.end((error) => settle(error)); } catch (error) { settle(error); }
  });
}

/** Writes already-encoded frames. Calls must be awaited; concurrent calls fail rather than queuing unbounded output. */
export class PluginFrameWriter {
  #writable;
  #limits;
  #closed = false;
  #closing = false;
  #writing = false;
  #endOnClose;
  #writtenBytes = 0;

  constructor({ writable, limits, endOnClose = true }) {
    if (!writable || typeof writable.write !== 'function') throw new TypeError('PluginFrameWriter requires a writable stream.');
    if (typeof endOnClose !== 'boolean') throw new TypeError('PluginFrameWriter endOnClose must be a boolean.');
    this.#writable = writable;
    this.#limits = normalizeLimits(limits);
    this.#endOnClose = endOnClose;
  }

  get closed() { return this.#closed; }
  get writtenBytes() { return this.#writtenBytes; }

  async write(frame) {
    if (this.#closed || this.#closing) fail('PLUGIN_FRAME_OUTPUT_CLOSED', 'Plugin frame output is closed.', 410);
    if (this.#writing) fail('PLUGIN_FRAME_OUTPUT_BUSY', 'Plugin frame output must be written serially.', 429);
    const value = assertFrame(frame, this.#limits.maxFrameBytes);
    if (value.length > this.#limits.maxCumulativeBytes - this.#writtenBytes) {
      this.abort();
      fail('PLUGIN_FRAME_CUMULATIVE_LIMIT', 'Plugin frame output exceeds the cumulative byte limit.', 413);
    }
    this.#writing = true;
    try {
      if (!this.#writable.write(value)) await waitForDrain(this.#writable);
      this.#writtenBytes += value.length;
    } finally {
      this.#writing = false;
    }
  }

  async close() {
    if (this.#closed) return false;
    if (this.#closing) fail('PLUGIN_FRAME_OUTPUT_BUSY', 'Plugin frame output is already closing.', 429);
    if (this.#writing) fail('PLUGIN_FRAME_OUTPUT_BUSY', 'Plugin frame output must finish writing before close.', 429);
    this.#closing = true;
    try {
      if (this.#endOnClose && typeof this.#writable.end === 'function' && !this.#writable.writableEnded) {
        await endWritable(this.#writable);
      }
      if (this.#closed) fail('PLUGIN_FRAME_OUTPUT_ABORTED', 'Plugin frame output was aborted.', 499);
      this.#closed = true;
      return true;
    } catch (error) {
      this.#closed = true;
      throw error;
    } finally {
      this.#closing = false;
    }
  }

  abort(reason = new HostError('PLUGIN_FRAME_OUTPUT_ABORTED', 'Plugin frame output was aborted.', 499)) {
    if (this.#closed) return false;
    this.#closed = true;
    if (typeof this.#writable.destroy === 'function') {
      if (reason instanceof Error && typeof this.#writable.once === 'function') {
        this.#writable.once('error', () => {});
      }
      this.#writable.destroy(reason);
    }
    return true;
  }

  cancel(reason) { return this.abort(reason); }
}
