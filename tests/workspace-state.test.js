import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceStateStore, WORKSPACE_NAMESPACES } from '../scripts/host/workspace-state.mjs';

const firstDocument = '11111111-1111-4111-8111-111111111111';
const secondDocument = '22222222-2222-4222-8222-222222222222';

function store(options) {
  return new WorkspaceStateStore((id) => id === firstDocument || id === secondDocument, options);
}

test('workspace state supports every typed namespace and immutable serializable snapshots', () => {
  const state = store();
  let revision = 0;
  for (const [index, namespace] of WORKSPACE_NAMESPACES.entries()) {
    const snapshot = state.createEntity(firstDocument, namespace, { id: `record-${index}`, label: namespace }, { expectedRevision: revision });
    revision = snapshot.revision;
    assert.equal(snapshot.namespaces[namespace][0].label, namespace);
  }
  const snapshot = state.exportSnapshot(firstDocument);
  assert.equal(snapshot.revision, WORKSPACE_NAMESPACES.length);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.throws(() => { snapshot.namespaces.bookmarks.push({ id: 'mutate' }); }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('workspace mutations enforce revisions and do not mutate state on failure', () => {
  const state = store();
  const created = state.createEntity(firstDocument, 'annotations', { id: 'note-1', text: 'first' });
  assert.throws(() => state.updateEntity(firstDocument, 'annotations', 'note-1', { id: 'note-1', text: 'lost' }, { expectedRevision: 0 }), { code: 'REVISION_CONFLICT', status: 409 });
  assert.equal(state.snapshot(firstDocument).namespaces.annotations[0].text, 'first');
  const updated = state.updateEntity(firstDocument, 'annotations', 'note-1', { id: 'note-1', text: 'second', replies: [], status: 'open', properties: {} }, { expectedRevision: created.revision });
  assert.equal(updated.namespaces.annotations[0].text, 'second');
  assert.equal(state.deleteEntity(firstDocument, 'annotations', 'note-1', { expectedRevision: updated.revision }).namespaces.annotations.length, 0);
});

test('workspace read lease freezes one exact revision until idempotent release', () => {
  const state = store();
  const created = state.createEntity(firstDocument, 'redactions', { id: 'plan-1' });
  const lease = state.acquireReadLease(firstDocument, { expectedRevision: created.revision });
  assert.equal(lease.revision, 1);
  assert.equal(lease.snapshot.namespaces.redactions[0].id, 'plan-1');
  assert.equal(lease.assertCurrent().revision, 1);
  assert.throws(
    () => state.appendAuditEvent(firstDocument, { kind: 'changed' }, { expectedRevision: 1 }),
    { code: 'WORKSPACE_READ_LEASED', status: 409 },
  );
  assert.throws(
    () => state.acquireReadLease(firstDocument, { expectedRevision: 1 }),
    { code: 'WORKSPACE_BUSY', status: 409 },
  );
  assert.throws(() => state.deleteDocument(firstDocument), { code: 'WORKSPACE_READ_LEASED' });
  lease.release();
  lease.release();
  assert.throws(() => lease.assertCurrent(), { code: 'WORKSPACE_LEASE_RELEASED' });
  assert.equal(state.appendAuditEvent(firstDocument, { kind: 'changed' }, { expectedRevision: 1 }).revision, 2);
});

test('workspace rejects invalid state, pollution keys, paths, excessive depth, and missing documents', () => {
  const state = store({ limits: { maxDepth: 2, maxEntitiesPerNamespace: 1 } });
  assert.throws(() => state.snapshot('not-an-id'), { code: 'INVALID_ID' });
  assert.throws(() => state.snapshot('33333333-3333-4333-8333-333333333333'), { code: 'DOCUMENT_NOT_FOUND' });
  assert.throws(() => state.createEntity(firstDocument, 'annotations', { id: 'safe', nested: { one: { two: { three: true } } } }), { code: 'STATE_TOO_DEEP' });
  assert.throws(() => state.createEntity(firstDocument, 'annotations', JSON.parse('{"id":"bad","__proto__":{"polluted":true}}')), { code: 'UNSAFE_STATE_KEY' });
  assert.throws(() => state.createEntity(firstDocument, 'annotations', { id: 'path', source: '/private/file.pdf' }), { code: 'INVALID_STATE' });
  state.createEntity(firstDocument, 'annotations', { id: 'one' });
  assert.throws(() => state.createEntity(firstDocument, 'annotations', { id: 'two' }), { code: 'ENTITY_LIMIT_EXCEEDED' });
});

test('workspace documents are isolated and audit entries are trimmed', () => {
  const state = store({ limits: { maxAuditEntries: 2 } });
  const created = state.createEntity(firstDocument, 'bookmarks', { id: 'bookmark-1' });
  state.appendAuditEvent(firstDocument, { kind: 'opened' }, { expectedRevision: created.revision });
  const snapshot = state.appendAuditEvent(firstDocument, { kind: 'reviewed' }, { expectedRevision: created.revision + 1 });
  state.createEntity(secondDocument, 'bookmarks', { id: 'bookmark-2' });
  assert.equal(snapshot.audit.length, 2);
  assert.deepEqual(snapshot.audit.map((entry) => entry.revision), [2, 3]);
  assert.equal(state.snapshot(secondDocument).namespaces.bookmarks[0].id, 'bookmark-2');
  assert.equal(state.snapshot(firstDocument).namespaces.bookmarks[0].id, 'bookmark-1');
});

test('workspace imports a validated snapshot as a new revision', () => {
  const state = store();
  const original = state.createEntity(firstDocument, 'formValues', { id: 'field-a', value: 'old' });
  const imported = structuredClone(original);
  imported.namespaces.formValues[0].value = 'new';
  const replaced = state.importSnapshot(firstDocument, imported, { expectedRevision: original.revision });
  assert.equal(replaced.revision, 2);
  assert.equal(replaced.namespaces.formValues[0].value, 'new');
  assert.equal(replaced.audit.at(-1).action, 'replace');
});

test('workspace state can be discarded when its host document closes', () => {
  const state = store();
  state.createEntity(firstDocument, 'bookmarks', { id: 'bookmark-1' });
  state.deleteDocument(firstDocument);
  assert.equal(state.snapshot(firstDocument).revision, 0);
  assert.equal(state.snapshot(firstDocument).namespaces.bookmarks.length, 0);
});
