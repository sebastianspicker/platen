import { HostError } from './host-error.mjs';
import {
  WORKSPACE_NAMESPACES,
  assertWorkspaceAuditEvent,
  assertWorkspaceEntity,
  assertWorkspaceJsonSafe,
  cloneWorkspaceJson,
  freezeWorkspaceJson,
  makeWorkspaceState,
} from './workspace-state-contract.mjs';

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

export function appendWorkspaceAudit(state, entry, limits) {
  state.audit.push({ revision: state.revision, ...entry });
  if (state.audit.length > limits.maxAuditEntries) {
    state.audit.splice(0, state.audit.length - limits.maxAuditEntries);
  }
}

export function assertWorkspaceSnapshotSize(state, limits) {
  if (JSON.stringify(state).length > limits.maxSnapshotBytes) {
    fail('STATE_TOO_LARGE', 'Workspace state exceeds the session size limit.', 413);
  }
}

export function copyWorkspaceState(state) {
  return freezeWorkspaceJson(cloneWorkspaceJson(state));
}

export function validateWorkspaceSnapshot(documentId, snapshot, limits) {
  assertWorkspaceJsonSafe(snapshot, limits);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.documentId !== documentId || !Number.isSafeInteger(snapshot.revision)
    || snapshot.revision < 0) {
    fail('INVALID_SNAPSHOT', 'The workspace snapshot is invalid.');
  }
  if (!snapshot.namespaces || typeof snapshot.namespaces !== 'object'
    || Array.isArray(snapshot.namespaces)) {
    fail('INVALID_SNAPSHOT', 'The workspace snapshot namespaces are invalid.');
  }

  const state = makeWorkspaceState(documentId);
  for (const namespace of WORKSPACE_NAMESPACES) {
    const records = snapshot.namespaces[namespace];
    if (!Array.isArray(records) || records.length > limits.maxEntitiesPerNamespace) {
      fail('INVALID_SNAPSHOT', 'The workspace snapshot contains invalid namespace data.');
    }
    const ids = new Set();
    state.namespaces[namespace] = records.map((entity) => {
      assertWorkspaceEntity(entity, limits);
      if (ids.has(entity.id)) {
        fail(
          'INVALID_SNAPSHOT',
          'The workspace snapshot contains duplicate entity identifiers.',
        );
      }
      ids.add(entity.id);
      return cloneWorkspaceJson(entity);
    });
  }
  if (Object.keys(snapshot.namespaces).some(
    (key) => !WORKSPACE_NAMESPACES.includes(key),
  )) {
    fail('INVALID_SNAPSHOT', 'The workspace snapshot contains an unknown namespace.');
  }
  if (!Array.isArray(snapshot.audit) || snapshot.audit.length > limits.maxAuditEntries) {
    fail('INVALID_SNAPSHOT', 'The workspace snapshot audit trail is invalid.');
  }
  for (const event of snapshot.audit) assertWorkspaceAuditEvent(event, limits);
  state.audit = cloneWorkspaceJson(snapshot.audit);
  assertWorkspaceSnapshotSize(state, limits);
  return state;
}
