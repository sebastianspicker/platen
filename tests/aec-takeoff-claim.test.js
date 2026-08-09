import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createDomainWorkspaceController } from '../src/controllers/domain-workspace-controller.js';
import { AecDomain } from '../scripts/host/domains/aec-domain.mjs';
import { DomainFacade } from '../scripts/host/domain-facade.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { fixture, invoke, makeTextPdf } from './support/host-router-fixture.js';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_A = 'a'.repeat(64);
const SOURCE_B = 'b'.repeat(64);
const AUTH = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-platen-token': 'test-session-token',
});

function measurement(id, overrides = {}) {
  const kind = overrides.kind ?? 'distance';
  const contract = {
    area: ['area', 'm2'], count: ['count', 'count'], distance: ['length', 'm'], perimeter: ['length', 'm'],
  }[kind];
  return {
    schemaVersion: 2,
    id,
    type: 'measurement',
    source: { documentSha256: overrides.sourceSha256 ?? SOURCE_A, page: 1 },
    calibrationId: kind === 'count' ? null : 'scale-1',
    kind,
    result: {
      dimension: overrides.dimension ?? contract[0],
      siValue: overrides.siValue ?? 1,
      siUnit: overrides.siUnit ?? contract[1],
    },
    provenanceSha256: overrides.provenanceSha256 ?? createHash('sha256').update(id).digest('hex'),
    createdAt: '2026-08-02T00:00:00.000Z',
  };
}

function setup(records = []) {
  const store = new WorkspaceStateStore((value) => value === DOCUMENT_ID);
  let state = store.snapshot(DOCUMENT_ID);
  for (const record of records) {
    state = store.createEntity(DOCUMENT_ID, 'measurements', record, { expectedRevision: state.revision });
  }
  return { store, state, facade: new DomainFacade(store) };
}

function executeTakeoff(facade, state, input) {
  return facade.execute(DOCUMENT_ID, {
    group: 'AEC', operation: 'takeoff', body: { input, options: { expectedRevision: state.revision } },
  });
}

function unsafeDomain(records) {
  const snapshot = {
    revision: 0,
    namespaces: {
      annotations: [], forms: [], measurements: records, metadata: [], reviewRecords: [],
      takeoffs: [], workflowRecords: [], redactions: [], signing: [], accessibility: [], collaboration: [],
    },
    audit: [],
  };
  return new AecDomain({ snapshot: () => snapshot });
}

async function upload(handler) {
  const response = await invoke(handler, {
    method: 'POST', url: '/api/documents',
    headers: { ...AUTH, 'content-type': 'application/pdf' },
    body: makeTextPdf('source-bound takeoff'),
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body).document;
}

function callDomain(handler, documentId, body) {
  return invoke(handler, {
    method: 'POST', url: `/api/documents/${documentId}/domain`, headers: AUTH, body: JSON.stringify(body),
  });
}

test('source-bound takeoff aggregates deterministic SI quantities and provenance without PDF output', () => {
  const records = [
    measurement('m-distance', { siValue: 4 }),
    measurement('m-area', { kind: 'area', siValue: 12 }),
    measurement('m-count', { kind: 'count', siValue: 3 }),
  ];
  const { state, facade } = setup(records);
  const output = executeTakeoff(facade, state, {
    sourceSha256: SOURCE_A, measurementIds: ['m-distance', 'm-count', 'm-area'], group: 'floor-1',
  });
  const record = output.namespaces.takeoffs.at(-1);

  assert.equal(record.sourceSha256, SOURCE_A);
  assert.equal(record.basisRevision, state.revision);
  assert.deepEqual(record.measurementIds, ['m-area', 'm-count', 'm-distance']);
  assert.deepEqual(record.quantities, { count: 3, m: 4, m2: 12 });
  assert.equal(record.measurementProvenanceDigests.length, 3);
  assert.match(record.provenanceDigest, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(record, 'pdf'), false);
});

test('source-bound takeoff rejects invalid selection, binding, provenance, and unit semantics', () => {
  const valid = measurement('valid');
  const { state, facade } = setup([valid, measurement('other-source', { sourceSha256: SOURCE_B })]);
  const attempt = (measurementIds, sourceSha256 = SOURCE_A) => executeTakeoff(facade, state, {
    sourceSha256, measurementIds, group: 'default',
  });

  assert.throws(() => attempt([]), { code: 'INVALID_MEASUREMENT_IDS' });
  assert.throws(() => attempt(['valid', 'valid']), { code: 'INVALID_MEASUREMENT_IDS' });
  assert.throws(() => attempt(['missing']), { code: 'AEC_MEASUREMENT_NOT_FOUND' });
  assert.throws(() => attempt(['valid', 'other-source']), { code: 'SOURCE_VERSION_MISMATCH' });
  assert.throws(() => attempt(['valid'], SOURCE_B), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  assert.throws(() => executeTakeoff(facade, state, {
    sourceSha256: SOURCE_A, measurementIds: Array.from({ length: 101 }, (_, index) => `m-${index}`),
  }), { code: 'INVALID_LIST' });

  const invalid = [
    measurement('negative', { siValue: -1 }),
    measurement('nonfinite', { siValue: Number.NaN }),
    measurement('wrong-unit', { siUnit: 'm2' }),
    { ...measurement('no-proof'), provenanceSha256: undefined },
  ];
  for (const record of invalid) {
    const domain = unsafeDomain([record]);
    assert.throws(() => domain.takeoff(DOCUMENT_ID, {
      sourceSha256: SOURCE_A, measurementIds: [record.id], group: 'default',
    }, { expectedRevision: 0 }), { code: 'INVALID_MEASUREMENT' });
  }
});

test('authenticated takeoff route rejects forged digests and stale revisions', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  let state = workspaceState.snapshot(document.id);
  state = workspaceState.createEntity(document.id, 'measurements', measurement('route-measurement', {
    sourceSha256,
  }), { expectedRevision: state.revision });

  const body = (source, revision) => ({
    group: 'AEC', operation: 'takeoff',
    body: { input: { sourceSha256: source, measurementIds: ['route-measurement'], group: 'default' }, options: { expectedRevision: revision } },
  });
  const valid = await callDomain(handler, document.id, body(sourceSha256, state.revision));
  assert.equal(valid.statusCode, 200);
  const takeoff = JSON.parse(valid.body).result.namespaces.takeoffs.at(-1);
  assert.equal(takeoff.sourceSha256, sourceSha256);
  assert.equal(Object.hasOwn(takeoff, 'pdf'), false);

  const currentRevision = workspaceState.snapshot(document.id).revision;
  const forged = await callDomain(handler, document.id, body(SOURCE_B, currentRevision));
  assert.equal(forged.statusCode, 409);
  assert.equal(JSON.parse(forged.body).error.code, 'SOURCE_VERSION_MISMATCH');
  const stale = await callDomain(handler, document.id, body(sourceSha256, 0));
  assert.equal(stale.statusCode, 409);
  assert.equal(JSON.parse(stale.body).error.code, 'REVISION_CONFLICT');
});

function controllerFixture({ current, cancelled }) {
  class TestFile extends Blob {
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.name = name;
    }
  }
  const state = {
    analysis: { documentId: DOCUMENT_ID, sha256: SOURCE_A }, domainRevision: 2,
    selectedDomainOperation: { group: 'AEC', operation: 'takeoff' },
    domainPayload: JSON.stringify({ input: { sourceSha256: SOURCE_A, measurementIds: ['m-1'] }, options: { expectedRevision: 2 } }),
    domainBusy: false, domainError: null, domainResult: null,
  };
  const operation = { documentId: DOCUMENT_ID, controller: new AbortController() };
  const announcements = [];
  const controller = createDomainWorkspaceController({
    state,
    client: { executeDomain: async () => {
      if (cancelled) { operation.controller.abort(); throw new Error('cancelled'); }
      return { revision: 3, record: { id: 'stale' } };
    } },
    getDocumentOperations: () => ({ activeController: null }),
    connectLocalHost: async () => {}, openFile: async () => {}, removeHostDocument: async () => {},
    captureOperation: () => operation, operationIsCurrent: () => current,
    syncAecRecordIds: () => {}, triggerDownload: () => {},
    finishOperation: () => {}, render: () => {}, announce: (message) => announcements.push(message),
    File: TestFile,
  });
  return { state, controller, announcements };
}

test('domain controller suppresses stale and cancelled takeoff success', async () => {
  const stale = controllerFixture({ current: false, cancelled: false });
  await stale.controller.runDomainOperation();
  assert.equal(stale.state.domainResult, null);
  assert.deepEqual(stale.announcements, []);

  const cancelled = controllerFixture({ current: true, cancelled: true });
  await cancelled.controller.runDomainOperation();
  assert.equal(cancelled.state.domainResult, null);
  assert.deepEqual(cancelled.announcements, []);
  assert.equal(cancelled.state.domainError, 'The local workflow was cancelled.');
});
