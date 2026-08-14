import { randomBytes } from 'node:crypto';
import { HostError } from './host-error.mjs';
import {
  assertOperationInputs,
  assertPluginOperationNotCancelled,
  getLaunchDescriptor,
  makeOperationBinding,
} from './plugin-operation-session-contract.mjs';
import { createOperationCleanup, createOperationSession } from './plugin-operation-session-lifecycle.mjs';

/**
 * Composes one host-owned activation, operation, grant, document handle, and
 * transport-independent RPC broker. It deliberately does not spawn code.
 * A native supervisor must consume the launch descriptor and satisfy the
 * complete production execution gate before this session can reach a worker.
 */
export async function createPluginOperationSession(options = {}) {
  const {
    packages, grants, handles, pluginId, documentId, permissions, methods, rpcLimits,
    ttlMs = 5 * 60_000, usageLimit = 256, byteLimit = 32 * 1024 * 1024,
    randomBytesImpl = randomBytes, audit = () => {}, signal,
  } = options;
  assertOperationInputs({ packages, grants, handles, pluginId, documentId, permissions, methods, randomBytesImpl, audit, signal });
  assertPluginOperationNotCancelled(signal);
  const launchDescriptor = await getLaunchDescriptor(packages, pluginId);
  assertPluginOperationNotCancelled(signal);
  const identity = makeOperationBinding(launchDescriptor, pluginId, randomBytesImpl);
  const cleanup = createOperationCleanup({ grants, handles, audit, launchDescriptor, pluginId, ...identity });
  try {
    const grant = await grants.issue({ binding: identity.binding, documentId, operationId: identity.operationId, permissions, methods, ttlMs, usageLimit });
    assertPluginOperationNotCancelled(signal);
    const documentHandle = handles.issue({ grantId: grant.grantId, binding: identity.binding, documentId, operationId: identity.operationId, methods, ttlMs, usageLimit, byteLimit });
    return createOperationSession({ launchDescriptor, handles, rpcLimits, audit, grant, documentHandle, methods, cleanup, ...identity });
  } catch (error) {
    try { cleanup('setup-failed'); } catch (cleanupError) {
      throw new HostError('PLUGIN_OPERATION_SETUP_CLEANUP_FAILED', 'Plugin operation setup failed and local authority cleanup was incomplete.', 500, { cause: new AggregateError([error, cleanupError], 'Plugin setup and cleanup failures.') });
    }
    throw error;
  }
}
