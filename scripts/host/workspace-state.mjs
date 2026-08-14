import { HostError } from './host-error.mjs';
import {
  DEFAULT_WORKSPACE_LIMITS,
  WORKSPACE_NAMESPACES,
  assertWorkspaceAuditEvent,
  assertWorkspaceDocumentId,
  assertWorkspaceEntity,
  assertWorkspaceEntityId,
  assertWorkspaceNamespace,
  cloneWorkspaceJson,
  makeWorkspaceState,
  normalizeWorkspaceLimits,
} from './workspace-state-contract.mjs';
import {
  appendWorkspaceAudit,
  assertWorkspaceSnapshotSize,
  copyWorkspaceState,
  validateWorkspaceSnapshot,
} from './workspace-state-snapshot.mjs';

export { DEFAULT_WORKSPACE_LIMITS, WORKSPACE_NAMESPACES };

function fail(code, message, status = 400) {
  throw new HostError(code, message, status);
}

/** A bounded, session-only state store for a single local document per key. */
export class WorkspaceStateStore {
  #documentExists;
  #limits;
  #states = new Map();
  #readLeases = new Map();

  constructor(documentStoreOrExists, { limits } = {}) {
    if (typeof documentStoreOrExists === 'function') {
      this.#documentExists = documentStoreOrExists;
    } else if (typeof documentStoreOrExists?.getDocument === 'function') {
      this.#documentExists = (documentId) => {
        documentStoreOrExists.getDocument(documentId);
        return true;
      };
    } else if (typeof documentStoreOrExists?.documentExists === 'function') {
      this.#documentExists = documentStoreOrExists.documentExists;
    } else {
      throw new TypeError(
        'WorkspaceStateStore requires a document store or document existence callback.',
      );
    }
    this.#limits = normalizeWorkspaceLimits(limits);
  }

  snapshot(documentId) {
    return copyWorkspaceState(this.#get(documentId));
  }

  acquireReadLease(documentId, { expectedRevision } = {}) {
    const state = this.#get(documentId);
    this.#assertExpectedRevision(state, expectedRevision);
    if (this.#readLeases.has(documentId)) {
      fail('WORKSPACE_BUSY', 'This workspace already has an active read lease.', 409);
    }
    const token = Symbol('workspace-read-lease');
    const leasedRevision = state.revision;
    let released = false;
    this.#readLeases.set(documentId, { token, revision: leasedRevision });
    const assertCurrent = () => {
      const active = this.#readLeases.get(documentId);
      if (released || active?.token !== token) {
        fail(
          'WORKSPACE_LEASE_RELEASED',
          'The workspace read lease is no longer active.',
          409,
        );
      }
      const current = this.#lookup(documentId);
      if (!current || current.revision !== leasedRevision) {
        fail('REVISION_CONFLICT', 'The workspace changed during the leased operation.', 409);
      }
      return copyWorkspaceState(current);
    };
    const release = () => {
      if (released) return;
      if (this.#readLeases.get(documentId)?.token === token) {
        this.#readLeases.delete(documentId);
      }
      released = true;
    };
    return Object.freeze({
      revision: leasedRevision,
      snapshot: copyWorkspaceState(state),
      assertCurrent,
      release,
    });
  }

  createEntity(documentId, namespace, entity, { expectedRevision } = {}) {
    assertWorkspaceNamespace(namespace);
    assertWorkspaceEntity(entity, this.#limits);
    return this.#mutate(documentId, expectedRevision, (state) => {
      const records = state.namespaces[namespace];
      if (records.length >= this.#limits.maxEntitiesPerNamespace) {
        fail(
          'ENTITY_LIMIT_EXCEEDED',
          'This workspace namespace has reached its entity limit.',
          413,
        );
      }
      if (records.some((record) => record.id === entity.id)) {
        fail(
          'ENTITY_EXISTS',
          'A workspace entity with this identifier already exists.',
          409,
        );
      }
      records.push(cloneWorkspaceJson(entity));
      return { action: 'create', namespace, entityId: entity.id };
    });
  }

  updateEntity(documentId, namespace, entityId, entity, { expectedRevision } = {}) {
    assertWorkspaceNamespace(namespace);
    assertWorkspaceEntityId(entityId);
    assertWorkspaceEntity(entity, this.#limits, entityId);
    return this.#mutate(documentId, expectedRevision, (state) => {
      const index = state.namespaces[namespace].findIndex(
        (record) => record.id === entityId,
      );
      if (index === -1) {
        fail('ENTITY_NOT_FOUND', 'The workspace entity was not found.', 404);
      }
      state.namespaces[namespace][index] = cloneWorkspaceJson(entity);
      return { action: 'update', namespace, entityId };
    });
  }

  deleteEntity(documentId, namespace, entityId, { expectedRevision } = {}) {
    assertWorkspaceNamespace(namespace);
    assertWorkspaceEntityId(entityId);
    return this.#mutate(documentId, expectedRevision, (state) => {
      const records = state.namespaces[namespace];
      const index = records.findIndex((record) => record.id === entityId);
      if (index === -1) {
        fail('ENTITY_NOT_FOUND', 'The workspace entity was not found.', 404);
      }
      records.splice(index, 1);
      return { action: 'delete', namespace, entityId };
    });
  }

  appendAuditEvent(documentId, event, { expectedRevision } = {}) {
    assertWorkspaceAuditEvent(event, this.#limits);
    return this.#mutate(
      documentId,
      expectedRevision,
      () => ({ action: 'event', event: cloneWorkspaceJson(event) }),
    );
  }

  exportSnapshot(documentId) {
    return this.snapshot(documentId);
  }

  replaceSnapshot(documentId, snapshot, { expectedRevision } = {}) {
    this.#assertWritable(documentId);
    const current = this.#lookup(documentId) ?? makeWorkspaceState(documentId);
    this.#assertDocumentCapacity(documentId);
    this.#assertExpectedRevision(current, expectedRevision);
    const replacement = validateWorkspaceSnapshot(documentId, snapshot, this.#limits);
    replacement.revision = current.revision + 1;
    appendWorkspaceAudit(replacement, { action: 'replace' }, this.#limits);
    assertWorkspaceSnapshotSize(replacement, this.#limits);
    this.#states.set(documentId, replacement);
    return copyWorkspaceState(replacement);
  }

  importSnapshot(documentId, snapshot, options) {
    return this.replaceSnapshot(documentId, snapshot, options);
  }

  deleteDocument(documentId) {
    assertWorkspaceDocumentId(documentId);
    this.#assertWritable(documentId);
    this.#states.delete(documentId);
  }

  create(...args) { return this.createEntity(...args); }
  update(...args) { return this.updateEntity(...args); }
  delete(...args) { return this.deleteEntity(...args); }

  #get(documentId) {
    let state = this.#lookup(documentId);
    if (!state) {
      this.#assertDocumentCapacity(documentId);
      state = makeWorkspaceState(documentId);
      this.#states.set(documentId, state);
    }
    return state;
  }

  #lookup(documentId) {
    assertWorkspaceDocumentId(documentId);
    try {
      if (!this.#documentExists(documentId)) {
        fail('DOCUMENT_NOT_FOUND', 'The local document session was not found.', 404);
      }
    } catch (error) {
      if (error instanceof HostError) throw error;
      fail('DOCUMENT_NOT_FOUND', 'The local document session was not found.', 404);
    }
    return this.#states.get(documentId);
  }

  #mutate(documentId, expectedRevision, operation) {
    this.#assertWritable(documentId);
    const state = this.#lookup(documentId) ?? makeWorkspaceState(documentId);
    this.#assertDocumentCapacity(documentId);
    this.#assertExpectedRevision(state, expectedRevision);
    const draft = cloneWorkspaceJson(state);
    const audit = operation(draft);
    draft.revision += 1;
    appendWorkspaceAudit(draft, audit, this.#limits);
    assertWorkspaceSnapshotSize(draft, this.#limits);
    this.#states.set(documentId, draft);
    return copyWorkspaceState(draft);
  }

  #assertDocumentCapacity(documentId) {
    if (!this.#states.has(documentId) && this.#states.size >= this.#limits.maxDocuments) {
      fail(
        'WORKSPACE_LIMIT_EXCEEDED',
        'The session has reached its document workspace limit.',
        413,
      );
    }
  }

  #assertExpectedRevision(state, expectedRevision) {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision)
      || expectedRevision < 0 || expectedRevision !== state.revision)) {
      fail(
        'REVISION_CONFLICT',
        'The workspace state revision does not match the expected revision.',
        409,
      );
    }
  }

  #assertWritable(documentId) {
    if (this.#readLeases.has(documentId)) {
      fail(
        'WORKSPACE_READ_LEASED',
        'The workspace cannot change during a source-bound read operation.',
        409,
      );
    }
  }
}
