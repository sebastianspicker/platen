import assert from 'node:assert/strict';
import test from 'node:test';

import { DomainFacade } from '../scripts/host/domain-facade.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { fixture, invoke, makeTextPdf } from './support/host-router-fixture.js';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_B = 'b'.repeat(64);
const AUTH = Object.freeze({
  origin: 'http://127.0.0.1:4173',
  'content-type': 'application/json',
  'x-platen-token': 'test-session-token',
});

async function upload(handler) {
  const response = await invoke(handler, {
    method: 'POST',
    url: '/api/documents',
    headers: { ...AUTH, 'content-type': 'application/pdf' },
    body: makeTextPdf('source-bound geospatial documents'),
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body).document;
}

function responseCode(response) {
  return JSON.parse(response.body).error.code;
}

function callDomain(handler, documentId, operation, body) {
  return invoke(handler, {
    method: 'POST',
    url: `/api/documents/${documentId}/domain`,
    headers: AUTH,
    body: JSON.stringify({ group: 'AEC', operation, body }),
  });
}

function createCalibration(handler, documentId, sourceSha256, revision, overrides = {}) {
  return callDomain(handler, documentId, 'calibrateGeoPage', {
    input: {
      page: 2,
      origin: { x: 12, y: -8 },
      scale: 2,
      rotation: 0,
      ...overrides,
      ...(sourceSha256 === null ? {} : { sourceSha256 }),
    },
    options: { expectedRevision: revision },
  });
}

function convertPoint(handler, documentId, calibrationId, point, sourceSha256, revision, extra = {}) {
  return callDomain(handler, documentId, 'pageToGeo', {
    calibrationId,
    pagePoint: point,
    ...(sourceSha256 === null ? {} : { sourceSha256 }),
    ...(revision === null ? {} : { options: { expectedRevision: revision } }),
    ...extra,
  });
}

function computeAffine(pagePoint, calibration) {
  const radians = calibration.rotation * Math.PI / 180;
  const x = pagePoint.x * calibration.scale;
  const y = pagePoint.y * calibration.scale;
  return {
    x: calibration.origin.x + x * Math.cos(radians) - y * Math.sin(radians),
    y: calibration.origin.y + x * Math.sin(radians) + y * Math.cos(radians),
  };
}


test('authenticated geospatial calibration stores source-bound records and deterministic conversion', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const revision = workspaceState.snapshot(document.id).revision;

  const calibrationResponse = await createCalibration(handler, document.id, sourceSha256, revision);
  assert.equal(calibrationResponse.statusCode, 200);
  const calibration = JSON.parse(calibrationResponse.body).result.namespaces.metadata.at(-1);
  assert.equal(calibration.sourceSha256, sourceSha256);
  assert.equal(calibration.basisRevision, revision);
  assert.equal(calibration.model, 'local-affine-page-v1');
  assert.equal(calibration.type, 'geo-calibration');

  const pagePoint = { x: 3, y: 4 };
  const conversionRevision = workspaceState.snapshot(document.id).revision;
  const metadataCount = workspaceState.snapshot(document.id).namespaces.metadata.length;
  const converted = await convertPoint(handler, document.id, calibration.id, pagePoint, sourceSha256, conversionRevision);
  assert.equal(converted.statusCode, 200);
  const envelope = JSON.parse(converted.body).result;
  assert.equal(envelope.kind, 'source-bound-aec-affine-coordinate');
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.model, 'local-affine-page-v1');
  assert.equal(envelope.calibrationId, calibration.id);
  assert.equal(envelope.page, calibration.page);
  assert.equal(envelope.sourceSha256, sourceSha256);
  assert.equal(envelope.workspaceRevision, workspaceState.snapshot(document.id).revision);
  assert.deepEqual(envelope.pagePoint, pagePoint);
  assert.deepEqual(envelope.coordinate, computeAffine(pagePoint, calibration));
  assert.equal(Object.hasOwn(envelope, 'pdf'), false);
  assert.equal(Object.hasOwn(envelope, 'sourceDigest'), false);
  assert.equal(Object.hasOwn(envelope, 'crs'), false);
  assert.equal(workspaceState.snapshot(document.id).revision, conversionRevision);
  assert.equal(workspaceState.snapshot(document.id).namespaces.metadata.length, metadataCount);
});

test('authenticated geospatial routes reject forged/stale/calibration-source mismatches and malformed inputs', async (context) => {
  const { handler, store, workspaceState } = await fixture(context);
  const document = await upload(handler);
  const sourceSha256 = store.getDocument(document.id).sha256;
  const revision = workspaceState.snapshot(document.id).revision;

  const created = await createCalibration(handler, document.id, sourceSha256, revision);
  assert.equal(created.statusCode, 200);
  const calibrationId = JSON.parse(created.body).result.namespaces.metadata.at(-1).id;
  const currentRevision = workspaceState.snapshot(document.id).revision;

  const forged = await createCalibration(handler, document.id, SOURCE_B, currentRevision);
  assert.equal(forged.statusCode, 409);
  assert.equal(responseCode(forged), 'SOURCE_VERSION_MISMATCH');

  const stale = await createCalibration(handler, document.id, sourceSha256, 0);
  assert.equal(stale.statusCode, 409);
  assert.equal(responseCode(stale), 'REVISION_CONFLICT');

  const fractionalPage = await createCalibration(handler, document.id, sourceSha256, currentRevision, { page: 1.5 });
  assert.equal(fractionalPage.statusCode, 400);
  assert.equal(responseCode(fractionalPage), 'INVALID_PARAMETER');

  const malformedOrigin = await createCalibration(handler, document.id, sourceSha256, currentRevision, { origin: { x: '1', y: 2 } });
  assert.equal(malformedOrigin.statusCode, 400);

  const badScale = await createCalibration(handler, document.id, sourceSha256, currentRevision, { scale: 0 });
  assert.equal(badScale.statusCode, 400);
  assert.equal(responseCode(badScale), 'INVALID_PARAMETER');

  const badScaleHigh = await createCalibration(handler, document.id, sourceSha256, currentRevision, { scale: 100_000.1 });
  assert.equal(badScaleHigh.statusCode, 400);

  const badRotation = await createCalibration(handler, document.id, sourceSha256, currentRevision, { rotation: 361 });
  assert.equal(badRotation.statusCode, 400);
  assert.equal(responseCode(badRotation), 'INVALID_PARAMETER');

  const forgedConversion = await convertPoint(handler, document.id, calibrationId, { x: 1, y: 2 }, SOURCE_B, currentRevision);
  assert.equal(forgedConversion.statusCode, 409);
  assert.equal(responseCode(forgedConversion), 'SOURCE_VERSION_MISMATCH');

  const staleConversion = await convertPoint(handler, document.id, calibrationId, { x: 1, y: 2 }, sourceSha256, 0);
  assert.equal(staleConversion.statusCode, 409);
  assert.equal(responseCode(staleConversion), 'REVISION_CONFLICT');

  const malformedPoint = await convertPoint(handler, document.id, calibrationId, { x: 1 }, sourceSha256, currentRevision);
  assert.equal(malformedPoint.statusCode, 400);
  assert.equal(responseCode(malformedPoint), 'INVALID_PARAMETER');

  const malformedPointValue = await convertPoint(handler, document.id, calibrationId, { x: 1, y: Infinity }, sourceSha256, currentRevision);
  assert.equal(malformedPointValue.statusCode, 400);

  const calibration = workspaceState.snapshot(document.id).namespaces.metadata.find((record) => record.id === calibrationId);
  const tampered = workspaceState.updateEntity(document.id, 'metadata', calibrationId, {
    ...calibration,
    sourceSha256: SOURCE_B,
  }, { expectedRevision: currentRevision });
  const mismatchCalibration = await convertPoint(handler, document.id, calibrationId, { x: 1, y: 2 }, sourceSha256, tampered.revision);
  assert.equal(mismatchCalibration.statusCode, 409);
  assert.equal(responseCode(mismatchCalibration), 'SOURCE_VERSION_MISMATCH');
});

test('legacy geospatial methods remain source-unbound and return coordinates', () => {
  const store = new WorkspaceStateStore((value) => value === DOCUMENT_ID);
  const facade = new DomainFacade(store);
  let state = store.snapshot(DOCUMENT_ID);
  state = facade.execute(DOCUMENT_ID, {
    group: 'AEC',
    operation: 'calibrateGeoPage',
    body: {
      input: {
        id: 'legacy-geo',
        page: 1,
        origin: { x: 1, y: 2 },
        scale: 2,
        rotation: 45,
      },
      options: { expectedRevision: state.revision },
    },
  });

  const record = state.namespaces.metadata.at(-1);
  const result = facade.execute(DOCUMENT_ID, {
    group: 'AEC',
    operation: 'pageToGeo',
    body: {
      calibrationId: record.id,
      pagePoint: { x: 3, y: 4 },
    },
  });

  assert.equal(typeof result.x, 'number');
  assert.equal(typeof result.y, 'number');
  assert.equal(Object.hasOwn(record, 'sourceSha256'), false);
  assert.equal(Object.hasOwn(record, 'basisRevision'), false);
  assert.equal(Object.hasOwn(record, 'model'), false);
  assert.equal(Object.hasOwn(result, 'sourceSha256'), false);
  assert.equal(Object.hasOwn(result, 'kind'), false);
});
