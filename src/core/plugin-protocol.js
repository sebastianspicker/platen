import { PlatenError } from './errors.js';

export const PLUGIN_PROTOCOL_VERSION = 1;
export const MAX_RPC_BYTES = 64 * 1024;

const baseFields = [
  'protocol', 'nonce', 'pluginId', 'version', 'packageHash', 'activationId', 'type', 'id', 'sequence',
];
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const hashPattern = /^[0-9a-f]{64}$/;
const bindingIdPattern = /^[A-Za-z0-9_-]{16,128}$/;

function encodedSize(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new PlatenError('REQUEST_INVALID', 'Plugin message must be JSON-serializable.');
  }
}

export function validateRpcRequest(message, context) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new PlatenError('REQUEST_INVALID', 'Plugin request must be an object.');
  }
  if (encodedSize(message) > (context.maxBytes ?? MAX_RPC_BYTES)) {
    throw new PlatenError('REQUEST_TOO_LARGE', 'Plugin request exceeds the message size limit.');
  }
  const fields = [...baseFields, 'method', 'params'];
  if (Object.keys(message).some((field) => !fields.includes(field)) || fields.some((field) => !Object.hasOwn(message, field))) {
    throw new PlatenError('REQUEST_INVALID', 'Plugin request has an invalid envelope.');
  }
  if (message.protocol !== PLUGIN_PROTOCOL_VERSION || message.type !== 'request') {
    throw new PlatenError('REQUEST_INVALID', 'Plugin request uses an unsupported protocol or type.');
  }
  const binding = context.binding ?? context;
  if (message.nonce !== binding.nonce || message.pluginId !== binding.pluginId
    || message.version !== binding.version || message.packageHash !== binding.packageHash
    || message.activationId !== binding.activationId || context.source !== context.expectedSource) {
    throw new PlatenError('REQUEST_INVALID', 'Plugin request failed its session binding checks.');
  }
  if (!idPattern.test(message.id) || !semverPattern.test(message.version) || !hashPattern.test(message.packageHash)
    || !bindingIdPattern.test(message.activationId) || !Number.isSafeInteger(message.sequence) || message.sequence < 1
    || !['document.getMetadata', 'document.readRange'].includes(message.method)) {
    throw new PlatenError('REQUEST_INVALID', 'Plugin request ID or method is invalid.');
  }
  if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) {
    throw new PlatenError('REQUEST_INVALID', 'Plugin request params must be an object.');
  }
  return message;
}

export function resultEnvelope(request, value) {
  return {
    protocol: PLUGIN_PROTOCOL_VERSION,
    nonce: request.nonce,
    pluginId: request.pluginId,
    version: request.version,
    packageHash: request.packageHash,
    activationId: request.activationId,
    type: 'result',
    id: request.id,
    sequence: request.sequence,
    value,
  };
}

export function errorEnvelope(request, error) {
  return {
    protocol: PLUGIN_PROTOCOL_VERSION,
    nonce: request.nonce,
    pluginId: request.pluginId,
    version: request.version,
    packageHash: request.packageHash,
    activationId: request.activationId,
    type: 'error',
    id: request.id,
    sequence: request.sequence,
    error: {
      code: 'PLUGIN_REQUEST_FAILED',
      message: 'The local plugin request was denied or could not be completed.',
    },
  };
}
