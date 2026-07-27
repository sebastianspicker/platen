import { HostError } from './host-error.mjs';
import { PluginFrameWriter } from './plugin-frame-stream.mjs';
export const DEFAULT_PLUGIN_TRANSPORT_MAX_CONCURRENT_REQUESTS = 4;
export const MAX_PLUGIN_TRANSPORT_CONCURRENT_REQUESTS = 64;

function cancelledError() { return new HostError('PLUGIN_TRANSPORT_CANCELLED', 'The private plugin transport was cancelled.', 499); }
function assertTransportAuthority(session) { if (!session || typeof session.processFrame !== 'function' || typeof session.close !== 'function') throw new TypeError('Plugin transport requires a bound operation session.'); }
function normalizeConcurrentRequests(value) { if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PLUGIN_TRANSPORT_CONCURRENT_REQUESTS) throw new TypeError('maxConcurrentRequests must be an integer from 1 through 64.'); return value; }
function resolveConcurrentRequests(value, session) { const authorityLimit = session.maxConcurrentRequests === undefined ? null : normalizeConcurrentRequests(session.maxConcurrentRequests); const requested = normalizeConcurrentRequests(value ?? authorityLimit ?? DEFAULT_PLUGIN_TRANSPORT_MAX_CONCURRENT_REQUESTS); if (authorityLimit !== null && requested > authorityLimit) throw new TypeError('maxConcurrentRequests cannot exceed the bound RPC session limit.'); return requested; }

export function preparePluginRpcTransport({ readable, writable, session, limits, signal, endOutput = true, maxConcurrentRequests } = {}) {
  assertTransportAuthority(session);
  try {
    if (!readable || typeof readable[Symbol.asyncIterator] !== 'function' || typeof readable.destroy !== 'function') throw new TypeError('Plugin transport requires a destroyable async-readable stream.');
    if (!writable || typeof writable.write !== 'function' || typeof writable.destroy !== 'function' || typeof writable.once !== 'function' || typeof writable.off !== 'function' || typeof writable.end !== 'function') throw new TypeError('Plugin transport requires a destroyable evented writable stream.');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    const requestLimit = resolveConcurrentRequests(maxConcurrentRequests, session);
    if (signal?.aborted) throw cancelledError();
    return { requestLimit, writer: new PluginFrameWriter({ writable, limits, endOnClose: endOutput }) };
  } catch (error) {
    const reason = error?.code === 'PLUGIN_TRANSPORT_CANCELLED' ? 'transport-cancelled' : 'transport-setup-failed'; const cleanupErrors = []; let authorityClosed = false;
    for (let attempt = 0; attempt < 2 && !authorityClosed; attempt += 1) { try { session.close(reason); authorityClosed = true; } catch (cleanupError) { cleanupErrors.push(cleanupError); } }
    if (!authorityClosed) throw new HostError('PLUGIN_TRANSPORT_SETUP_CLEANUP_FAILED', 'The private plugin transport setup failed and could not close operation authority.', 500, { cause: new AggregateError([error, ...cleanupErrors], 'Plugin transport setup and cleanup failures.') });
    throw error;
  }
}
