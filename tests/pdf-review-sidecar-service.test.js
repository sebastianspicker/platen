import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REVIEW_SIDECAR_INSPECTION_KIND,
  REVIEW_SIDECAR_STATUS_KIND,
  freezeReviewSidecarResult,
  normalizeReviewSidecarInspectionRequest,
  normalizeReviewSidecarStatusRequest,
} from '../scripts/host/pdf-review-sidecar-contract.mjs';
import { PdfReviewSidecarService } from '../scripts/host/pdf-review-sidecar-service.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const sourceSha256 = 'a'.repeat(64);
const query = Object.freeze({ search: '', status: null, type: null, groupBy: 'none', sortBy: 'createdAt', direction: 'asc' });

function annotation() {
  return {
    id: 'annotation-1', prototypeSidecar: true, type: 'comment', page: 1,
    rectangle: [1, 2, 3, 4], text: 'Retained local comment', author: 'local',
    status: 'open', properties: {}, mentions: [], createdAt: '2026-08-03T10:00:00.000Z', replies: [],
  };
}

function setup({ documents: replacement } = {}) {
  const documents = replacement ?? {
    getDocument: (id) => ({ id, sha256: sourceSha256 }),
    verifySource: async () => true,
  };
  const workspace = new WorkspaceStateStore((id) => id === documentId);
  const service = new PdfReviewSidecarService({ documents, workspace, clock: () => '2026-08-03T10:01:00.000Z' });
  return { documents, workspace, service };
}

test('review sidecar updates only retained annotation state and appends one local activity', async () => {
  const { workspace, service } = setup();
  workspace.createEntity(documentId, 'annotations', annotation());
  const result = await service.setStatus(documentId, {
    sourceSha256, expectedRevision: 1, annotationId: 'annotation-1', status: 'custom', customStatus: 'needs-local-review',
  });
  assert.deepEqual(result, {
    kind: REVIEW_SIDECAR_STATUS_KIND, sourceDigest: sourceSha256, revision: 2,
    annotationId: 'annotation-1', status: 'custom', customStatus: 'needs-local-review', localOnly: true,
  });
  assert.equal(Object.isFrozen(result), true);
  const state = workspace.snapshot(documentId);
  assert.equal(state.namespaces.annotations[0].customStatus, 'needs-local-review');
  assert.deepEqual(state.namespaces.reviewRecords.map((record) => record.kind), ['activity']);
  assert.equal(state.namespaces.reviewRecords[0].activity, 'status');
});

test('review sidecar inspection is source-bound, lease-backed, and returns retained activity only', async () => {
  const { workspace, service } = setup();
  workspace.createEntity(documentId, 'annotations', annotation());
  workspace.createEntity(documentId, 'reviewRecords', { id: 'activity-remote', kind: 'activity', annotationId: 'annotation-1', activity: 'created', actor: 'local', detail: '', at: '2026-08-03T10:00:00.000Z' });
  workspace.createEntity(documentId, 'reviewRecords', { id: 'notification-1', type: 'notification', localOnly: true });
  const result = await service.inspect(documentId, { sourceSha256, expectedRevision: 3, query });
  assert.equal(result.kind, REVIEW_SIDECAR_INSPECTION_KIND);
  assert.equal(result.count, 1);
  assert.equal(result.activity.length, 1);
  assert.equal(result.activity[0].id, 'activity-remote');
  assert.deepEqual(result.limitations, ['Local session sidecar only; no PDF annotations are read or written.']);
  assert.equal(Object.isFrozen(result.annotationsOrGroups), true);
  assert.equal(workspace.snapshot(documentId).revision, 3);
});

test('review sidecar rejects stale source, revision, invalid combinations, poison, and cancellation without mutation', async () => {
  const { workspace, service } = setup();
  workspace.createEntity(documentId, 'annotations', annotation());
  const before = workspace.snapshot(documentId);
  await assert.rejects(service.setStatus(documentId, { sourceSha256, expectedRevision: 0, annotationId: 'annotation-1', status: 'open', customStatus: null }), { code: 'REVISION_CONFLICT', status: 409 });
  await assert.rejects(service.setStatus(documentId, { sourceSha256, expectedRevision: 1, annotationId: 'annotation-1', status: 'open', customStatus: 'not-allowed' }), { code: 'INVALID_REVIEW_SIDECAR_REQUEST' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.inspect(documentId, { sourceSha256, expectedRevision: 1, query }, { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.deepEqual(workspace.snapshot(documentId), before);
  const poisoned = {}; Object.defineProperty(poisoned, 'sourceSha256', { enumerable: true, get: () => sourceSha256 });
  Object.assign(poisoned, { expectedRevision: 1, annotationId: 'annotation-1', status: 'open', customStatus: null });
  assert.throws(() => normalizeReviewSidecarStatusRequest(poisoned), { code: 'INVALID_REVIEW_SIDECAR_REQUEST' });
  assert.throws(() => normalizeReviewSidecarInspectionRequest({ sourceSha256, expectedRevision: 1, query: { ...query, sortBy: 'unsafe' } }), { code: 'INVALID_REVIEW_SIDECAR_REQUEST' });
});

test('review sidecar re-verifies source before its only workspace replacement', async () => {
  let digest = sourceSha256;
  let checks = 0;
  const documents = {
    getDocument: (id) => ({ id, sha256: digest }),
    verifySource: async () => { checks += 1; if (checks === 2) digest = 'b'.repeat(64); },
  };
  const { workspace, service } = setup({ documents });
  workspace.createEntity(documentId, 'annotations', annotation());
  const before = workspace.snapshot(documentId);
  await assert.rejects(service.setStatus(documentId, {
    sourceSha256, expectedRevision: 1, annotationId: 'annotation-1', status: 'resolved', customStatus: null,
  }), { code: 'REVIEW_SIDECAR_SOURCE_MISMATCH', status: 409 });
  assert.equal(checks, 2);
  assert.deepEqual(workspace.snapshot(documentId), before);
});

test('sidecar result validator accepts both exact receipt shapes and rejects injected result poison', () => {
  const status = freezeReviewSidecarResult({ kind: REVIEW_SIDECAR_STATUS_KIND, sourceDigest: sourceSha256, revision: 2, annotationId: 'annotation-1', status: 'open', customStatus: null, localOnly: true });
  assert.equal(status.kind, REVIEW_SIDECAR_STATUS_KIND);
  const inspection = freezeReviewSidecarResult({
    kind: REVIEW_SIDECAR_INSPECTION_KIND, sourceDigest: sourceSha256, revision: 2,
    annotationsOrGroups: [annotation()], count: 1,
    commentSummary: [{ id: 'annotation-1', status: 'open', replies: 0, text: 'Retained local comment' }],
    activity: [{ id: 'activity-1', kind: 'activity', annotationId: 'annotation-1', activity: 'status', actor: 'local-sidecar', detail: 'open', at: '2026-08-03T10:00:00.000Z' }],
    limitations: ['Local session sidecar only; no PDF annotations are read or written.'], localOnly: true,
  });
  assert.equal(inspection.kind, REVIEW_SIDECAR_INSPECTION_KIND);
  const poisoned = { ...status }; Object.defineProperty(poisoned, 'status', { enumerable: true, get: () => 'open' });
  assert.throws(() => freezeReviewSidecarResult(poisoned), TypeError);
  assert.throws(() => freezeReviewSidecarResult({ ...inspection, annotationsOrGroups: [{ ...annotation(), privateField: 'must-not-cross-route' }] }), TypeError);
  assert.throws(() => freezeReviewSidecarResult({ ...inspection, activity: [{ ...inspection.activity[0], unrelatedRecord: true }] }), TypeError);
});
