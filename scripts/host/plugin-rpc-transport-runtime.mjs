import { HostError } from './host-error.mjs';
import { PluginFrameParser } from './plugin-frame-stream.mjs';
import { decodePluginRpcFrame } from './plugin-rpc-contract.mjs';

function cancelledError() { return new HostError('PLUGIN_TRANSPORT_CANCELLED', 'The private plugin transport was cancelled.', 499); }
function normalizeTransportFailure(error) { return error instanceof Error ? error : new HostError('PLUGIN_TRANSPORT_FAILED', 'The private plugin transport failed.', 500); }
function frameLane(frame, limits) { const maxBytes = limits?.maxFrameBytes; const message = decodePluginRpcFrame(frame, maxBytes === undefined ? {} : { maxBytes }); return message.type === 'cancel' ? 'control' : 'request'; }

export async function runPreparedPluginRpcTransport({ readable, session, limits, signal, requestLimit, writer }) {
  let frameCount = 0; let authorityClosed = false; let terminatingError = null; const cleanupErrors = []; const shutdownErrors = []; const activeTasks = new Set(); const activeRequests = new Set(); const activeControls = new Set(); let writeTail = Promise.resolve(); let ioStopped = false; let parser;
  const closeAuthority = (reason) => { if (authorityClosed) return false; const result = session.close(reason); authorityClosed = true; return result; };
  const stopTransport = (error, reason) => { const failure = normalizeTransportFailure(error); if (!terminatingError) terminatingError = failure; if (!authorityClosed) { try { closeAuthority(reason); } catch (cleanupError) { cleanupErrors.push(cleanupError); } } if (ioStopped) return; ioStopped = true; try { parser?.abort(); } catch (shutdownError) { shutdownErrors.push(shutdownError); } try { if (!writer.closed) writer.abort(failure); } catch (shutdownError) { shutdownErrors.push(shutdownError); } try { if (!readable.destroyed) readable.destroy(failure); } catch (shutdownError) { shutdownErrors.push(shutdownError); } };
  const enqueueWrite = (response) => { const next = writeTail.then(() => writer.write(response)); writeTail = next; return next; };
  const startFrame = (frame) => {
    const lane = frameLane(frame, limits); const laneTasks = lane === 'control' ? activeControls : activeRequests; const laneLimit = lane === 'control' ? 1 : requestLimit;
    if (laneTasks.size >= laneLimit) throw new HostError(lane === 'control' ? 'PLUGIN_TRANSPORT_CONTROL_LIMIT' : 'PLUGIN_TRANSPORT_INFLIGHT_LIMIT', lane === 'control' ? 'The private plugin transport control lane is occupied.' : 'The private plugin transport request limit is reached.', 429);
    const task = (async () => { const response = await session.processFrame(frame); await enqueueWrite(response); frameCount += 1; })();
    activeTasks.add(task); laneTasks.add(task); void task.catch((error) => stopTransport(error, 'transport-failed')).finally(() => { activeTasks.delete(task); laneTasks.delete(task); });
  };
  parser = new PluginFrameParser({ limits, onFrame: startFrame });
  const settleActive = async () => { while (activeTasks.size !== 0) await Promise.allSettled([...activeTasks]); };
  let aborted = false; const onAbort = () => { aborted = true; stopTransport(cancelledError(), 'transport-cancelled'); };
  signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
  try {
    for await (const chunk of readable) { if (aborted) throw cancelledError(); await parser.push(chunk); }
    if (aborted) throw cancelledError(); parser.finish(); await settleActive(); if (terminatingError) throw terminatingError; await writeTail; if (terminatingError) throw terminatingError; await writer.close(); if (terminatingError) throw terminatingError; closeAuthority('transport-eof');
    return Object.freeze({ frameCount, receivedBytes: parser.receivedBytes, writtenBytes: writer.writtenBytes, closeReason: 'transport-eof' });
  } catch (error) {
    const failure = terminatingError ?? normalizeTransportFailure(error); stopTransport(failure, aborted ? 'transport-cancelled' : 'transport-failed'); await settleActive(); let finalCleanupError = null;
    if (!authorityClosed) { try { closeAuthority(aborted ? 'transport-cancelled' : 'transport-failed'); } catch (cleanupError) { cleanupErrors.push(cleanupError); finalCleanupError = cleanupError; } }
    if (finalCleanupError || shutdownErrors.length !== 0) throw new HostError('PLUGIN_TRANSPORT_CLEANUP_FAILED', 'The private plugin transport could not finish operation cleanup.', 500, { cause: new AggregateError([failure, ...cleanupErrors, ...shutdownErrors], 'Plugin transport and cleanup failures.') });
    if (aborted && failure?.code !== 'PLUGIN_TRANSPORT_CANCELLED') throw cancelledError(); throw failure;
  } finally { signal?.removeEventListener('abort', onAbort); }
}
