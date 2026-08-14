import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewNotification, parseReviewNotification } from '../scripts/host/pdf-review-notifications-contract.mjs';
import { PdfReviewNotificationsService, mergeReviewNotifications } from '../scripts/host/pdf-review-notifications-service.mjs';
import { PdfReviewSharedExchangeService } from '../scripts/host/pdf-review-shared-exchange-service.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const sourceSha256 = 'a'.repeat(64);
function setup() {
  const documents = { getDocument: (id) => ({ id, sha256: sourceSha256 }), verifySource: async () => true };
  const workspace = new WorkspaceStateStore((id) => id === documentId);
  return { documents, workspace, service: new PdfReviewNotificationsService({ documents, workspace }) };
}
function annotation() {
  return { id: 'annotation-1', type: 'comment', page: 1, rectangle: { x: 1, y: 1, width: 2, height: 2 }, text: 'private', author: 'reviewer-author', status: 'open', customStatus: null, properties: {}, mentions: ['reviewer-target'], createdAt: '2026-07-21T10:00:00.000Z', replies: [{ id: 'comment-1', text: 'secret text', author: 'reviewer-author', at: '2026-07-21T10:01:00.000Z', mentions: ['reviewer-target'] }] };
}

test('notification contract is deterministic, source-bound, and privacy-safe', () => {
  const event = createReviewNotification({ sourceSha256, workspaceRevision: 1, annotationId: 'annotation-1', commentId: null, mentionedReviewer: 'reviewer-target', actorId: 'reviewer-author', timestamp: '2026-07-21T10:00:00.000Z' });
  assert.deepEqual(parseReviewNotification(structuredClone(event)), event);
  assert.equal(Object.hasOwn(event, 'text'), false);
  assert.throws(() => createReviewNotification({ sourceSha256, workspaceRevision: 1, annotationId: 'annotation-1', mentionedReviewer: 'person@example.com', actorId: 'reviewer-author', timestamp: event.timestamp }), { code: 'INVALID_REVIEW_NOTIFICATION' });
  assert.throws(() => parseReviewNotification({ ...event, summarySha256: 'b'.repeat(64) }), { code: 'INVALID_REVIEW_NOTIFICATION' });
});

test('notification generation is idempotent, atomic, isolated, and mark-read is revision-bound', async () => {
  const { service, workspace } = setup();
  workspace.createEntity(documentId, 'annotations', annotation());
  const generated = await service.generate(documentId, { expectedRevision: 1 });
  assert.equal(generated.applied, 2);
  const records = workspace.snapshot(documentId).namespaces.reviewRecords;
  assert.equal(records.length, 2);
  assert.equal(records.every((record) => record.status === 'unread'), true);
  assert.equal(records.every((record) => record.summarySha256 && !Object.hasOwn(record, 'text')), true);
  const replay = await service.generate(documentId);
  assert.equal(replay.idempotent, true);
  assert.equal(workspace.snapshot(documentId).revision, generated.revision);
  const marked = await service.markRead(documentId, records[0].id, { expectedRevision: generated.revision });
  assert.equal(marked.changed, true);
  assert.equal(workspace.snapshot(documentId).namespaces.reviewRecords.find((record) => record.id === records[0].id).status, 'read');
  await assert.rejects(service.markRead(documentId, records[1].id, { expectedRevision: generated.revision }), { code: 'REVISION_CONFLICT', status: 409 });
  const replayRead = await service.markRead(documentId, records[0].id);
  assert.equal(replayRead.idempotent, true);
});

test('notification generation rejects cancellation and stale source without mutation', async () => {
  const { service, workspace } = setup();
  workspace.createEntity(documentId, 'annotations', annotation());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.generate(documentId, { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.equal(workspace.snapshot(documentId).namespaces.reviewRecords.length, 0);
  let digest = sourceSha256;
  const documents = { getDocument: (id) => ({ id, sha256: digest }), verifySource: async () => { digest = 'b'.repeat(64); } };
  const drifting = new PdfReviewNotificationsService({ documents, workspace });
  await assert.rejects(drifting.generate(documentId), { code: 'REVIEW_NOTIFICATION_SOURCE_MISMATCH', status: 409 });
  assert.equal(workspace.snapshot(documentId).namespaces.reviewRecords.length, 0);
});

test('shared-review import commits annotation and mention notification in one revision', async () => {
  const source = setup(); source.workspace.createEntity(documentId, 'annotations', annotation());
  const exported = await new PdfReviewSharedExchangeService({ documents: source.documents, workspace: source.workspace }).export(documentId, { reviewerId: 'reviewer-author', baseRevision: 0 });
  const target = setup(); const imported = await new PdfReviewSharedExchangeService({ documents: target.documents, workspace: target.workspace }).import(documentId, exported.bytes);
  assert.equal(imported.applied, 2); assert.equal(imported.notificationsApplied, 1); assert.equal(imported.revision, 1);
  const snapshot = target.workspace.snapshot(documentId);
  assert.equal(snapshot.revision, 1); assert.equal(snapshot.namespaces.annotations.length, 1); assert.equal(snapshot.namespaces.reviewRecords.length, 1);
  assert.equal(snapshot.namespaces.reviewRecords[0].mentionedReviewer, 'reviewer-target');
});

test('notification generation replays safely under concurrent calls', async () => {
  const { service, workspace } = setup(); workspace.createEntity(documentId, 'annotations', annotation());
  const results = await Promise.all([service.generate(documentId), service.generate(documentId)]);
  assert.deepEqual(results.map((result) => result.applied).sort(), [0, 2]);
  assert.equal(workspace.snapshot(documentId).namespaces.reviewRecords.length, 2);
});

test('notification merge preserves hostile unrelated records and rejects immutable conflicts after read', () => {
  const event = createReviewNotification({ sourceSha256, workspaceRevision: 1, annotationId: 'annotation-1', mentionedReviewer: 'reviewer-target', actorId: 'reviewer-author', timestamp: '2026-07-21T10:00:00.000Z' });
  const hostile = {}; Object.defineProperty(hostile, 'type', { enumerable: true, get: () => { throw new Error('unrelated accessor invoked'); } });
  const merged = mergeReviewNotifications({ namespaces: { reviewRecords: [hostile] } }, [event], sourceSha256);
  assert.equal(merged.records[0], hostile); assert.equal(merged.added, 1);
  const changedActor = createReviewNotification({ sourceSha256, workspaceRevision: 2, annotationId: 'annotation-1', mentionedReviewer: 'reviewer-target', actorId: 'reviewer-other', timestamp: event.timestamp });
  assert.throws(() => mergeReviewNotifications({ namespaces: { reviewRecords: [{ ...event, status: 'read' }] } }, [changedActor], sourceSha256), { code: 'REVIEW_NOTIFICATION_CONFLICT', status: 409 });
});

test('mark-read race recovery ignores hostile unrelated record accessors', async () => {
  const event = createReviewNotification({ sourceSha256, workspaceRevision: 1, annotationId: 'annotation-1', mentionedReviewer: 'reviewer-target', actorId: 'reviewer-author', timestamp: '2026-07-21T10:00:00.000Z' });
  const hostile = {}; Object.defineProperty(hostile, 'id', { enumerable: true, get: () => { throw new Error('unrelated accessor invoked'); } });
  const base = { documentId, revision: 1, namespaces: { annotations: [], reviewRecords: [event] }, audit: [] };
  const latest = { documentId, revision: 2, namespaces: { annotations: [], reviewRecords: [hostile, { ...event, status: 'read' }] }, audit: [] };
  let snapshots = 0;
  const workspace = { snapshot: () => (snapshots++ === 0 ? base : latest), replaceSnapshot: () => { throw Object.assign(new Error('race'), { code: 'REVISION_CONFLICT', status: 409 }); } };
  const documents = { getDocument: (id) => ({ id, sha256: sourceSha256 }), verifySource: async () => true };
  const service = new PdfReviewNotificationsService({ documents, workspace });
  const result = await service.markRead(documentId, event.id);
  assert.equal(result.idempotent, true);
});
