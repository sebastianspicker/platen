import assert from 'node:assert/strict';
import test from 'node:test';
import { AecDomain } from '../scripts/host/domains/aec-domain.mjs';
import { CollaborationDomain } from '../scripts/host/domains/collaboration-domain.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const digestA = 'a'.repeat(64); const digestB = 'b'.repeat(64);
function setup() {
  let counter = 0;
  const store = new WorkspaceStateStore((value) => value === documentId);
  const options = { clock: () => '2026-07-18T10:00:00.000Z', idFactory: (prefix) => `${prefix}-${++counter}` };
  return { store, aec: new AecDomain(store, options), collaboration: new CollaborationDomain(store, options) };
}
function sourceBoundMeasurement(id, kind, siValue, siUnit) {
  return { schemaVersion: 2, id, type: 'measurement', source: { documentSha256: digestA, page: 1 }, kind, calibrationId: kind === 'count' ? null : 'calibration-a', result: { dimension: kind === 'area' ? 'area' : 'length', siValue, siUnit } };
}

test('AEC domain owns markup and takeoffs while source-bound AEC artifacts exclusively own measurements', () => {
  const { aec, store } = setup();
  let state = store.createEntity(documentId, 'measurements', sourceBoundMeasurement('measurement-1', 'distance', 10, 'm'), { expectedRevision: 0 });
  state = store.createEntity(documentId, 'measurements', sourceBoundMeasurement('measurement-2', 'area', 100, 'm2'), { expectedRevision: state.revision });
  state = aec.takeoff(documentId, { measurementIds: ['measurement-1', 'measurement-2'] }, { expectedRevision: state.revision });
  assert.deepEqual(state.namespaces.takeoffs[0].quantities, { m: 10, m2: 100 });
  state = aec.createMarkup(documentId, { type: 'concrete', page: 1 }, { expectedRevision: state.revision });
  state = aec.createMarkup(documentId, { type: 'steel', page: 2, status: 'closed' }, { expectedRevision: state.revision });
  assert.deepEqual(aec.legends(documentId), { concrete: 1, steel: 1 });
  assert.equal(aec.listMarkups(documentId, { status: 'closed' }).length, 1);
  state = aec.createSpace(documentId, { name: 'Room 1', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }, { expectedRevision: state.revision });
  state = aec.createSheet(documentId, { number: 'A101', title: 'Plan', tags: ['permit'] }, { expectedRevision: state.revision });
  state = aec.createDrawingSet(documentId, { name: 'Issued', sheets: ['sheet-3'] }, { expectedRevision: state.revision });
  state = aec.createRevisionOverlay(documentId, { fromDigest: digestA, toDigest: digestB, sheetId: 'sheet-3' }, { expectedRevision: state.revision });
  assert.equal(state.namespaces.reviewRecords.filter((item) => item.type === 'revision-overlay').length, 1);
  assert.equal(typeof aec.calibrateScale, 'undefined');
  assert.equal(typeof aec.measure, 'undefined');
  assert.equal(state.audit.some((entry) => entry.event?.kind === 'aec'), true);
});

test('AEC metadata is deterministic and collaboration owns revision status transitions', () => {
  const { aec, collaboration } = setup(); let revision = 0;
  let state = aec.createCustomColumn(documentId, { name: 'Total', formula: 'length * width + 2' }, { expectedRevision: revision }); revision = state.revision;
  assert.equal(aec.evaluateCustomColumn(documentId, 'column-1', { length: 3, width: 4 }), 14);
  assert.throws(() => aec.createCustomColumn(documentId, { name: 'Bad', formula: 'globalThis.process' }, { expectedRevision: revision }), { code: 'INVALID_FORMULA' });
  state = aec.createToolset(documentId, { name: 'QA', tools: ['cloud', 'arrow'] }, { expectedRevision: revision }); revision = state.revision;
  state = aec.createBatchPlan(documentId, { kind: 'slip-sheet', pairs: [{ from: 'sheet-a', to: 'sheet-b' }] }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.createRevision(documentId, { label: 'R1' }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.transitionRevision(documentId, 'revision-4', 'issued', { expectedRevision: revision }); revision = state.revision;
  assert.throws(() => collaboration.transitionRevision(documentId, 'revision-4', 'draft', { expectedRevision: revision }), { code: 'INVALID_STATUS_TRANSITION' });
  state = aec.calibrateGeoPage(documentId, { page: 1, origin: { x: 10, y: 20 }, scale: 2, rotation: 90 }, { expectedRevision: revision });
  const converted = aec.pageToGeo(documentId, 'geo-5', { x: 3, y: 4 }); assert.ok(Math.abs(converted.x - 2) < 1e-10); assert.ok(Math.abs(converted.y - 26) < 1e-10);
});

test('collaboration records remain local-only and locks detect conflicts', () => {
  const { collaboration } = setup(); let revision = 0;
  let state = collaboration.createProject(documentId, { name: 'Local Project' }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.createWorkspace(documentId, { name: 'Design' }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.recordParticipant(documentId, { name: 'Ada', role: 'reviewer' }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.createReviewSession(documentId, { workspaceId: 'workspace-2', participants: ['participant-3'] }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.recordActivity(documentId, { kind: 'opened', subjectId: 'review-4' }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.createNotification(documentId, { recipientId: 'participant-3', message: 'Review ready' }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.createSharePackage(documentId, { documentDigest: digestA, expiresAt: '2026-07-19T10:00:00.000Z' }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.recordVersion(documentId, { documentDigest: digestB, parentDigest: digestA }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.createRepositoryConnector(documentId, { name: 'Archive', kind: 'descriptor' }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.createRetentionRule(documentId, { name: 'Seven years', days: 2555 }, { expectedRevision: revision }); revision = state.revision;
  state = collaboration.checkout(documentId, { documentDigest: digestA, ownerId: 'participant-3' }, { expectedRevision: revision }); revision = state.revision;
  assert.throws(() => collaboration.checkout(documentId, { documentDigest: digestA, ownerId: 'other' }, { expectedRevision: revision }), { code: 'DOCUMENT_LOCKED', status: 409 });
  state = collaboration.checkin(documentId, 'lock-11', 'participant-3', { expectedRevision: revision }); revision = state.revision;
  state = collaboration.appendSyncJournal(documentId, { operation: 'merge', conflict: true, resolution: 'manual-review' }, { expectedRevision: revision });
  const all = Object.values(state.namespaces).flat();
  assert.equal(all.find((item) => item.type === 'local-share-package').networkLink, null);
  assert.equal(all.find((item) => item.type === 'repository-connector').auth, 'not-configured');
  assert.equal(all.every((item) => item.remoteAccess !== true), true);
  assert.equal(state.audit.some((entry) => entry.event?.kind === 'collaboration'), true);
});

test('collaboration preserves optimistic revisions and bounded local-only input', () => {
  const { collaboration } = setup();
  const state = collaboration.createProject(documentId, { name: 'One' }, { expectedRevision: 0 });
  assert.throws(() => collaboration.createProject(documentId, { name: 'Stale' }, { expectedRevision: 0 }), { code: 'REVISION_CONFLICT', status: 409 });
  assert.throws(() => collaboration.createProject(documentId, { name: 'Remote', offline: false }, { expectedRevision: state.revision }), { code: 'LOCAL_ONLY' });
});
