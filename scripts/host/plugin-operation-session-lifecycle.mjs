import { HostError } from './host-error.mjs';
import { PluginRpcSession } from './plugin-rpc-broker.mjs';
import { createPluginWorkerInvocation } from './plugin-worker-control.mjs';

export function createOperationCleanup({ grants, handles, audit, launchDescriptor, pluginId, activationId, operationId }) {
  let cleanupState = 'open';
  return (reason) => {
    if (cleanupState === 'closed' || cleanupState === 'cleaning') return false;
    cleanupState = 'cleaning'; const boundedReason = String(reason ?? 'operation-ended').slice(0, 120); let revokedHandles = 0; let revokedGrants = 0; const errors = [];
    try { revokedHandles = handles.revokeActivation(activationId, boundedReason); } catch (error) { errors.push(error); }
    try { revokedGrants = grants.revokeActivation(activationId, boundedReason); } catch (error) { errors.push(error); }
    try { audit({ type: 'plugin.operation.closed', pluginId, version: launchDescriptor.version, packageHash: launchDescriptor.digest, activationId, operationId, reason: boundedReason, revokedHandles, revokedGrants }); } catch (error) { errors.push(error); }
    if (errors.length !== 0) { cleanupState = 'failed'; throw new HostError('PLUGIN_OPERATION_CLEANUP_FAILED', 'The plugin operation could not revoke all local authority cleanly.', 500, { cause: new AggregateError(errors, 'Plugin operation cleanup failures.') }); }
    cleanupState = 'closed'; return true;
  };
}

export function createOperationSession({ launchDescriptor, handles, rpcLimits, audit, grant, documentHandle, methods, cleanup, rpcBinding }) {
  const broker = new PluginRpcSession({ binding: rpcBinding, handles, limits: rpcLimits, onClose: ({ reason }) => cleanup(reason) });
  audit({ type: 'plugin.operation.opened', pluginId: rpcBinding.pluginId, version: launchDescriptor.version, packageHash: launchDescriptor.digest, activationId: rpcBinding.activationId, operationId: rpcBinding.operationId, methods: Object.freeze([...methods]) });
  return Object.freeze({ launchDescriptor, binding: rpcBinding, grantId: grant.grantId, documentHandle: documentHandle.handle, processFrame(frame) { return broker.processFrame(frame); }, createInvocation(capability, input, options) { return createPluginWorkerInvocation({ binding: rpcBinding, declaredCapabilities: launchDescriptor.manifest.capabilities, capability, documentHandle: documentHandle.handle, input, limits: options?.limits }); }, close(reason = 'operation-ended') { const closed = broker.close(reason); if (!closed) cleanup(reason); return closed; }, get closed() { return broker.closed; }, get maxConcurrentRequests() { return broker.maxConcurrentRequests; } });
}
