import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAecWorkflowController,
  parseAecPoints,
} from '../src/controllers/aec-workflow-controller.js';

test('AEC point parsing is strict, finite, and bounded', () => {
  assert.deepEqual(parseAecPoints('1,2; 3.5,4'), [
    { x: 1, y: 2 },
    { x: 3.5, y: 4 },
  ]);
  for (const value of ['', '1', '1,', 'x,2', '1,2,3']) {
    assert.throws(() => parseAecPoints(value));
  }
  assert.throws(() => parseAecPoints(Array.from({ length: 51 }, () => '1,2').join(';')), /50 points/u);
});

test('AEC workflow controller records and publishes source-bound artifacts', async () => {
  const calls = [];
  const announcements = [];
  const state = {
    analysis: { documentId: 'document-1', sha256: 'a'.repeat(64) },
    selectedPage: 2,
    domainBusy: false,
    busyAction: null,
    domainRevision: 3,
    domainError: null,
    domainResult: null,
    aecCalibrationPoints: '10,20;30,20',
    aecRealLength: '4',
    aecCalibrationUnit: 'ft',
    aecMeasurementLabel: 'Wall',
    aecMeasurementKind: 'count',
    aecMeasurementPoints: '10,20;30,20',
    aecDisplayUnit: 'count',
    aecLastCalibrationId: null,
    aecLastMeasurementId: null,
    host: { aecNativeReady: true },
  };
  const operation = Object.freeze({ documentId: 'document-1', controller: new AbortController() });
  let finished = 0;
  const client = {
    async calibrateAec(documentId, payload) {
      calls.push({ method: 'calibrate', documentId, payload });
      return { workspaceRevision: 4, calibration: { id: payload.id } };
    },
    async measureAec(documentId, payload) {
      calls.push({ method: 'measure', documentId, payload });
      return {
        workspaceRevision: 5,
        measurement: {
          id: payload.id,
          result: { displayValue: '2', displayUnit: 'count' },
        },
      };
    },
    async materializeAec(documentId, payload) {
      calls.push({ method: 'materialize', documentId, payload });
      return { artifact: { id: 'artifact-1' }, measurementId: payload.measurementId };
    },
  };
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
  assert.equal(state.domainRevision, 4);
  assert.match(state.aecLastCalibrationId, /^calibration-/u);
  assert.deepEqual(calls[0].payload.points, [{ x: 10, y: 20 }, { x: 30, y: 20 }]);

  await controller.createAecMeasurement();
  assert.equal(state.domainRevision, 5);
  assert.match(state.aecLastMeasurementId, /^measurement-/u);
  assert.equal(calls[1].payload.calibrationId, null, 'count measurements do not consume a scale');
  assert.match(announcements.at(-1), /2 count/u);

  await controller.publishAecMeasurement();
  assert.equal(calls[2].payload.measurementId, state.aecLastMeasurementId);
  assert.equal(state.domainResult.measurementId, state.aecLastMeasurementId);
  assert.equal(finished, 3);
  assert.equal(state.domainBusy, false);

  controller.syncAecRecordIds({
    namespaces: {
      measurements: [
        { schemaVersion: 2, type: 'scale-calibration', id: 'calibration-old' },
        { schemaVersion: 2, type: 'measurement', id: 'measurement-latest' },
        { schemaVersion: 2, type: 'scale-calibration', id: 'calibration-latest' },
      ],
    },
  });
  assert.equal(state.aecLastCalibrationId, 'calibration-latest');
  assert.equal(state.aecLastMeasurementId, 'measurement-latest');
});
