import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { LocalHostClient } from '../src/core/local-host-client.js';
import { createAecWorkflowController } from '../src/controllers/aec-workflow-controller.js';
import { AecArtifactService } from '../scripts/host/aec-artifact-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import {
  fixture,
  invoke,
  makeTextPdf,
} from './support/host-router-fixture.js';

function makeCalibrationRequest(document, overrides = {}) {
  return {
    schemaVersion: 1,
    sourceSha256: document.sha256,
    expectedRevision: 0,
    id: 'calibration-1',
    page: 1,
    points: [{ x: 0, y: 0 }, { x: 72, y: 0 }],
    realLength: 1,
    unit: 'ft',
    label: 'Plan scale',
    ...overrides,
  };
}

async function setupArtifactService(context) {
  const store = await new DocumentStore({ root: mkdtempSync(join(tmpdir(), 'platen-aec-scale-')) }).initialize();
  context.after(() => store.dispose());
  const workspace = new WorkspaceStateStore(store);
  const document = await store.createDocument({
    stream: Readable.from([makeTextPdf('AEC SCALE CALIBRATION CLAIM')]),
    displayName: 'scale-calibration-claim.pdf',
  });
  const pdfService = {
    inspectStructure: async (_documentId, { firstPage }) => ({
      pageBoxes: [{
        page: firstPage,
        rotation: 0,
        boxes: { cropBox: { left: 0, bottom: 0, right: 612, top: 792 } },
      }],
    }),
  };
  const service = new AecArtifactService({
    store,
    workspaceState: workspace,
    pdfService,
    poppler: { execute() {} },
  });
  return { service, document, workspace, store };
}

function calibrationState(overrides = {}) {
  return {
    analysis: { documentId: 'document-1', sha256: 'a'.repeat(64) },
    selectedPage: 1,
    domainBusy: false,
    busyAction: null,
    domainRevision: 5,
    domainError: null,
    domainResult: null,
    aecCalibrationPoints: '0,0;72,0',
    aecRealLength: '1',
    aecCalibrationUnit: 'ft',
    aecMeasurementLabel: 'Hall',
    aecLastCalibrationId: 'calibration-existing',
    host: { aecArtifactsReady: true },
    ...overrides,
  };
}

function calibrationController({
  state,
  calibrateAec,
  operation = Object.freeze({ documentId: 'document-1', controller: new AbortController() }),
  operationIsCurrent = () => true,
  announce = () => {},
}) {
  return createAecWorkflowController({
    state,
    client: { calibrateAec },
    captureOperation: () => operation,
    operationIsCurrent,
    finishOperation: () => {},
    render: () => {},
    announce,
    confirm: () => true,
    cryptoApi: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    downloadDerivedArtifact: async () => true,
  });
}

test('AEC scale-calibration controller request binds live document context, digest, revision, geometry, and known-length', async () => {
  const calls = [];
  const state = {
    analysis: { documentId: 'document-1', sha256: 'A'.repeat(64) },
    selectedPage: 2,
    domainBusy: false,
    busyAction: null,
    domainRevision: 7,
    domainError: null,
    domainResult: null,
    aecCalibrationPoints: '10, 20; 40, 20',
    aecRealLength: '3.5',
    aecCalibrationUnit: 'ft',
    aecMeasurementLabel: 'Hall baseline',
    aecLastCalibrationId: null,
    host: { aecArtifactsReady: true },
  };
  const operation = Object.freeze({ documentId: 'document-1', controller: new AbortController() });
  const client = {
    async calibrateAec(documentId, payload) {
      calls.push({ documentId, payload });
      return { workspaceRevision: 8, calibration: { id: payload.id } };
    },
  };
  let finished = 0;
  const announcements = [];
  let sequence = 0;
  const controller = createAecWorkflowController({
    state,
    client,
    captureOperation: () => operation,
    operationIsCurrent: (candidate) => candidate === operation,
    finishOperation: () => { finished += 1; },
    downloadDerivedArtifact: async () => true,
    render: () => {},
    announce: (message) => announcements.push(message),
    confirm: () => true,
    cryptoApi: { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` },
  });

  await controller.createAecCalibration();

  assert.equal(state.domainRevision, 8);
  assert.equal(finished, 1);
  assert.equal(state.domainBusy, false);
  assert.match(state.aecLastCalibrationId, /^calibration-/u);
  const { payload } = calls.at(-1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].documentId, operation.documentId);
  assert.equal(payload.sourceSha256, 'a'.repeat(64));
  assert.equal(payload.expectedRevision, 7);
  assert.equal(payload.page, 2);
  assert.equal(payload.unit, 'ft');
  assert.equal(payload.points.length, 2);
  assert.ok(Number.isFinite(payload.points[0].x));
  assert.ok(Number.isFinite(payload.points[0].y));
  assert.ok(Number.isFinite(payload.points[1].x));
  assert.ok(Number.isFinite(payload.points[1].y));
  assert.notDeepEqual(payload.points[0], payload.points[1]);
  assert.ok(payload.realLength > 0);
  assert.equal(payload.realLength, 3.5);
  assert.equal(announcements.at(-1), 'Source-bound AEC scale calibration recorded locally.');
});

test('AEC scale-calibration is inert during busy or unavailable readiness', async () => {
  const calls = [];
  const busyState = calibrationState({ domainBusy: true });
  const unavailableState = calibrationState({ host: { aecArtifactsReady: false } });
  const calibrateAec = () => { calls.push('called'); return { workspaceRevision: 6, calibration: { id: 'unexpected' } }; };

  await calibrationController({ state: busyState, calibrateAec }).createAecCalibration();
  await calibrationController({ state: unavailableState, calibrateAec }).createAecCalibration();

  assert.deepEqual(calls, []);
  assert.equal(busyState.domainRevision, 5);
  assert.equal(unavailableState.domainRevision, 5);
});

test('AEC scale-calibration ignores stale or aborted completions', async () => {
  const calls = [];
  const staleState = calibrationState();
  const staleOperation = Object.freeze({ documentId: 'document-1', controller: new AbortController() });
  const staleController = calibrationController({
    state: staleState,
    operation: staleOperation,
    operationIsCurrent: () => false,
    calibrateAec: () => { calls.push('stale'); return { workspaceRevision: 6, calibration: { id: 'stale' } }; },
  });

  await staleController.createAecCalibration();
  assert.deepEqual(calls, ['stale']);
  assert.equal(staleState.domainRevision, 5);
  assert.equal(staleState.domainResult, null);
  assert.equal(staleState.aecLastCalibrationId, 'calibration-existing');

  const abortState = calibrationState();
  const abortOperation = Object.freeze({ documentId: 'document-1', controller: new AbortController() });
  const abortAnnouncements = [];
  const abortedController = calibrationController({
    state: abortState,
    operation: abortOperation,
    announce: (message) => abortAnnouncements.push(message),
    calibrateAec: async () => {
      abortOperation.controller.abort();
      return { workspaceRevision: 6, calibration: { id: 'aborted' } };
    },
  });
  await abortedController.createAecCalibration();
  assert.equal(abortState.domainRevision, 5);
  assert.equal(abortState.aecLastCalibrationId, 'calibration-existing');
  assert.equal(abortState.domainError, 'AEC calibration was cancelled.');
  assert.equal(abortAnnouncements.length, 0);
});

test('AEC calibration service rejects stale digests, stale revision, nonfinite/degenerate geometry, and invalid units', async (context) => {
  const { service, document } = await setupArtifactService(context);
  const request = makeCalibrationRequest(document);
  const mismatchSource = (document.sha256.at(0) === 'a' ? 'b' : 'a') + document.sha256.slice(1);

  await assert.rejects(service.calibrate(document.id, makeCalibrationRequest(document, { sourceSha256: mismatchSource })), {
    code: 'SOURCE_VERSION_MISMATCH',
    status: 409,
  });

  await service.calibrate(document.id, request);
  await assert.rejects(service.calibrate(document.id, makeCalibrationRequest(document, { expectedRevision: 0 })), {
    code: 'REVISION_CONFLICT',
    status: 409,
  });

  await assert.rejects(service.calibrate(document.id, makeCalibrationRequest(document, {
    points: [{ x: Number.NaN, y: 0 }, { x: 72, y: 0 }],
  })), {
    code: 'INVALID_AEC_CALIBRATION',
    status: 400,
  });

  await assert.rejects(service.calibrate(document.id, makeCalibrationRequest(document, {
    points: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
  })), {
    code: 'INVALID_AEC_CALIBRATION',
    status: 400,
  });

  await assert.rejects(service.calibrate(document.id, makeCalibrationRequest(document, {
    unit: 'yards',
  })), {
    code: 'INVALID_AEC_CALIBRATION',
    status: 400,
  });
});

test('client and route validation for AEC calibration are covered without derived PDF output', async (context) => {
  const calls = [];
  const client = new LocalHostClient({
    fetchImpl: async (path, options = {}) => {
      calls.push(path);
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessionToken: 'a'.repeat(64) }), { status: 200 });
      }
      throw new Error('unreachable');
    },
  });
  await client.bootstrap();
  await assert.rejects(async () => client.calibrateAec('document-1', makeCalibrationRequest({ sha256: 'A'.repeat(64) }, { id: 'calibration-1' })), (error) => {
    assert.equal(error.name, 'TypeError');
    assert.equal(error.code, 'AEC_CONTRACT_INVALID');
    return true;
  });
  assert.equal(calls.length, 1);

  const { handler, aecArtifacts, store } = await fixture(context);
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('ROUTE AEC CALIBRATION CLAIM')]), displayName: 'route.pdf' });
  const valid = await invoke(handler, {
    method: 'POST',
    url: `/api/documents/${document.id}/aec-calibration`,
    headers: {
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
      'x-platen-token': 'test-session-token',
    },
    body: JSON.stringify(makeCalibrationRequest(document)),
  });
  assert.equal(valid.statusCode, 201);
  assert.equal(aecArtifacts.calls.at(-1).operation, 'calibrate');
  assert.equal(aecArtifacts.calls.at(-1).documentId, document.id);
  assert.equal(aecArtifacts.calls.at(-1).body.sourceSha256, document.sha256);
});
