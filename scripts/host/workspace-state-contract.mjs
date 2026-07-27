import { HostError } from './host-error.mjs';

export const WORKSPACE_NAMESPACES = Object.freeze([
  'bookmarks', 'destinations', 'annotations', 'formFields', 'formValues', 'redactions',
  'accessibilityTags', 'accessibilityIssues', 'measurements', 'takeoffs', 'reviewRecords',
  'workflowRecords', 'metadata', 'policies', 'automations', 'adminSettings',
  'integrationSettings',
]);

export const DEFAULT_WORKSPACE_LIMITS = Object.freeze({
  maxDocuments: 64,
  maxEntitiesPerNamespace: 500,
  maxAuditEntries: 200,
  maxStringLength: 10_000,
  maxArrayLength: 1_000,
  maxObjectKeys: 100,
  maxDepth: 8,
  maxSnapshotBytes: 512 * 1024,
});

const OPAQUE_DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNSAFE_KEY = /^(?:__proto__|prototype|constructor)$/i;
const SECRET_KEY = /(?:secret|token|password|credential|authorization|api[_-]?key)/i;
const PATH_VALUE = /^(?:\/|~\/|\.\.?[\\/]|[A-Za-z]:[\\/]|\\\\)/;

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

export function cloneWorkspaceJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function freezeWorkspaceJson(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeWorkspaceJson(child);
  }
  return value;
}

export function normalizeWorkspaceLimits(limits) {
  const result = { ...DEFAULT_WORKSPACE_LIMITS };
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!(key in result) || !Number.isSafeInteger(value) || value < 1) {
      fail('INVALID_LIMITS', 'Workspace state limits must be positive integers.');
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

export function assertWorkspaceDocumentId(documentId) {
  if (!OPAQUE_DOCUMENT_ID.test(String(documentId ?? ''))) {
    fail('INVALID_ID', 'Invalid local document identifier.');
  }
}

export function assertWorkspaceEntityId(entityId) {
  if (!ENTITY_ID.test(String(entityId ?? '')) || UNSAFE_KEY.test(entityId)) {
    fail('INVALID_ID', 'Workspace entity identifiers must be opaque, bounded strings.');
  }
}

export function assertWorkspaceNamespace(namespace) {
  if (!WORKSPACE_NAMESPACES.includes(namespace)) {
    fail('INVALID_NAMESPACE', 'Unsupported workspace state namespace.');
  }
}

export function assertWorkspaceJsonSafe(value, limits, depth = 0) {
  if (depth > limits.maxDepth) {
    fail('STATE_TOO_DEEP', 'Workspace state exceeds the maximum nesting depth.', 413);
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('INVALID_STATE', 'Workspace state must contain finite JSON numbers.');
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.length > limits.maxStringLength) {
      fail('STATE_TOO_LARGE', 'Workspace state contains an overlong string.', 413);
    }
    if (PATH_VALUE.test(value)) {
      fail('INVALID_STATE', 'Workspace state must not contain filesystem paths.');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) {
      fail('STATE_TOO_LARGE', 'Workspace state contains an oversized array.', 413);
    }
    for (const item of value) assertWorkspaceJsonSafe(item, limits, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('INVALID_STATE', 'Workspace state must be JSON-safe plain data.');
  }
  const keys = Object.keys(value);
  if (keys.length > limits.maxObjectKeys) {
    fail('STATE_TOO_LARGE', 'Workspace state contains an oversized object.', 413);
  }
  for (const key of keys) {
    if (UNSAFE_KEY.test(key)) {
      fail('UNSAFE_STATE_KEY', 'Workspace state contains a prohibited object key.');
    }
    if (SECRET_KEY.test(key)) {
      fail('SECRET_MATERIAL_FORBIDDEN', 'Workspace state must not contain secret material.');
    }
    assertWorkspaceJsonSafe(value[key], limits, depth + 1);
  }
}

export function makeWorkspaceState(documentId) {
  return {
    documentId,
    revision: 0,
    namespaces: Object.fromEntries(
      WORKSPACE_NAMESPACES.map((namespace) => [namespace, []]),
    ),
    audit: [],
  };
}

export function assertWorkspaceEntity(entity, limits, expectedId) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)
    || entity.id !== (expectedId ?? entity.id)) {
    fail('INVALID_ENTITY', 'Workspace entities must be JSON objects with a stable identifier.');
  }
  assertWorkspaceEntityId(entity.id);
  assertWorkspaceJsonSafe(entity, limits);
}

export function assertWorkspaceAuditEvent(event, limits) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    fail('INVALID_AUDIT_EVENT', 'Audit events must be JSON objects.');
  }
  assertWorkspaceJsonSafe(event, limits);
}
