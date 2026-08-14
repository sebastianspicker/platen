import { HostError } from './host-error.mjs';
import {
  decodePluginRpcFrame,
  dispatchPluginRpcMethod,
  encodePluginRpcFrame,
  errorPluginRpcResult,
  normalizePluginRpcLimits,
  successPluginRpcResult,
  validatePluginRpcBinding,
  validatePluginRpcEnvelope,
  validatePluginRpcMethod,
} from './plugin-rpc-contract.mjs';

export {
  DEFAULT_PLUGIN_RPC_LIMITS,
  decodePluginRpcFrame,
  encodePluginRpcFrame,
  maxRpcReadRangeBytes,
  PLUGIN_RPC_PROTOCOL,
  normalizePluginRpcLimits as normalizePluginRpcLimits,
} from './plugin-rpc-contract.mjs';

/**
 * A transport-independent, non-executing broker. The future containment helper
 * may feed it private IPC frames; HTTP, stdout and browser postMessage are not transports.
 */
export class PluginRpcSession {
  #binding;
  #handles;
  #limits;
  #clock;
  #onClose;
  #nextSequence = 1;
  #seenIds = new Set();
  #inFlight = new Map();
  #requestTimes = [];
  #closed = false;

  constructor({ binding, handles, limits, clock = Date.now, onClose = () => {} }) {
    this.#binding = validatePluginRpcBinding(binding);
    if (!handles || typeof handles.getMetadata !== 'function' || typeof handles.readRange !== 'function') {
      throw new TypeError('PluginRpcSession requires a document handle broker.');
    }
    if (typeof clock !== 'function' || typeof onClose !== 'function') throw new TypeError('PluginRpcSession requires callable clock and onClose values.');
    this.#handles = handles;
    this.#limits = normalizePluginRpcLimits(limits);
    this.#clock = clock;
    this.#onClose = onClose;
  }

  get closed() { return this.#closed; }
  get maxConcurrentRequests() { return this.#limits.maxInFlight; }

  async processFrame(frame) {
    if (this.#closed) throw new HostError('PLUGIN_RPC_SESSION_CLOSED', 'The plugin RPC session is closed.', 410);
    const message = validatePluginRpcEnvelope(decodePluginRpcFrame(frame, {
      maxBytes: this.#limits.maxFrameBytes, limits: this.#limits,
    }), this.#binding);
    this.#claimMessage(message);
    if (message.type === 'cancel') return this.#cancel(message);
    validatePluginRpcMethod(message, this.#limits);
    if (this.#inFlight.size >= this.#limits.maxInFlight) throw new HostError('PLUGIN_RPC_INFLIGHT_LIMIT', 'The plugin RPC in-flight limit is reached.', 429);
    const controller = new AbortController();
    this.#inFlight.set(message.id, controller);
    let timeout;
    let onAbort;
    try {
      const context = {
        binding: {
          pluginId: this.#binding.pluginId,
          version: this.#binding.version,
          packageHash: this.#binding.packageHash,
          activationId: this.#binding.activationId,
        },
        operationId: this.#binding.operationId,
        signal: controller.signal,
      };
      const operation = dispatchPluginRpcMethod(message, this.#handles, context);
      const aborted = new Promise((resolve, reject) => {
        onAbort = () => {
          const reason = controller.signal.reason;
          reject(reason instanceof HostError
            ? reason
            : new HostError('PLUGIN_REQUEST_CANCELLED', 'The plugin request was cancelled.', 499));
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      timeout = setTimeout(() => {
        controller.abort(new HostError('PLUGIN_REQUEST_TIMEOUT', 'The plugin request exceeded its deadline.', 504));
      }, this.#limits.requestTimeoutMs);
      timeout.unref?.();
      const value = await Promise.race([operation, aborted]);
      if (controller.signal.aborted) throw new HostError('PLUGIN_REQUEST_CANCELLED', 'The plugin request was cancelled.', 499);
      return this.#encodeResult(successPluginRpcResult(message, value));
    } catch (error) {
      return this.#encodeResult(errorPluginRpcResult(message, error));
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      this.#inFlight.delete(message.id);
    }
  }

  close(reason = 'session-closed') {
    if (this.#closed) return false;
    this.#closed = true;
    for (const controller of this.#inFlight.values()) controller.abort(new Error('Plugin RPC session closed.'));
    this.#inFlight.clear();
    this.#onClose({ activationId: this.#binding.activationId, reason: String(reason).slice(0, 120) });
    return true;
  }

  #claimMessage(message) {
    if (message.sequence !== this.#nextSequence) throw new HostError('PLUGIN_RPC_SEQUENCE_INVALID', 'Plugin RPC sequence is out of order.', 409);
    if (this.#seenIds.has(message.id)) throw new HostError('PLUGIN_RPC_REPLAY', 'Plugin RPC message ID was already used.', 409);
    if (this.#seenIds.size >= this.#limits.maxSessionRequests) {
      this.close('request-limit');
      throw new HostError('PLUGIN_RPC_SESSION_LIMIT', 'The plugin RPC session request limit is reached.', 429);
    }
    const now = this.#clock();
    const cutoff = now - 60_000;
    this.#requestTimes = this.#requestTimes.filter((time) => time > cutoff);
    if (this.#requestTimes.length >= this.#limits.maxRequestsPerMinute) throw new HostError('PLUGIN_RPC_RATE_LIMIT', 'The plugin RPC rate limit is reached.', 429);
    this.#nextSequence += 1;
    this.#seenIds.add(message.id);
    this.#requestTimes.push(now);
  }

  #cancel(message) {
    const controller = this.#inFlight.get(message.targetId);
    if (controller) controller.abort(new Error('Cancelled by plugin request.'));
    return this.#encodeResult(successPluginRpcResult(message, { targetId: message.targetId, acknowledged: Boolean(controller) }));
  }

  #encodeResult(result) {
    return encodePluginRpcFrame(result, { maxBytes: this.#limits.maxResultBytes, limits: this.#limits });
  }
}
