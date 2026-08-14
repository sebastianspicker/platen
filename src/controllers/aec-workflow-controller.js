import { createAecCalibrationOperations } from './aec-workflow/calibration-operations.js';
import { createAecMeasurementOperations } from './aec-workflow/measurement-operations.js';
import { createAecPublicationOperations } from './aec-workflow/publication-operations.js';
import { syncAecRecordIds } from './aec-workflow/record-synchronization.js';
import { validateAecMeasurementLegendResult } from '../core/local-host-aec-measurement-legend-endpoints.js';

export function parseAecPoints(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Enter AEC points as x,y pairs separated by semicolons.');
  }
  const points = value.split(';').map((entry) => {
    const coordinates = entry.trim().split(',');
    if (coordinates.length !== 2 || coordinates.some((coordinate) => coordinate.trim() === '')) {
      throw new Error('Each AEC point must contain exactly x,y coordinates.');
    }
    const [x, y] = coordinates.map(Number);
    if (![x, y].every(Number.isFinite)) throw new Error('AEC coordinates must be finite numbers.');
    return { x, y };
  });
  if (points.length > 50) throw new Error('AEC geometry is limited to 50 points.');
  return points;
}

export function createAecWorkflowController({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  finishOperation,
  downloadDerivedArtifact,
  render,
  announce,
  confirm = globalThis.window?.confirm?.bind(globalThis.window),
  cryptoApi = globalThis.crypto,
  triggerDownload = () => {},
  BlobConstructor = globalThis.Blob,
}) {
  const callbacks = {
    captureOperation, operationIsCurrent, finishOperation, downloadDerivedArtifact, render, announce, confirm,
  };
  if (!state || !client || Object.values(callbacks).some((callback) => typeof callback !== 'function')) {
    throw new TypeError('AEC workflow controller requires state, client, and workflow callbacks.');
  }

  const dependencies = { state, client, cryptoApi, ...callbacks, parseAecPoints };
  const calibration = createAecCalibrationOperations(dependencies);
  const measurement = createAecMeasurementOperations(dependencies);
  const publication = createAecPublicationOperations(dependencies);
  async function generateAecMeasurementLegend() {
    if (!state.analysis.documentId || !Array.isArray(state.aecMeasurementIds) || !state.aecMeasurementIds.length || state.domainBusy || state.busyAction || state.host?.aecMeasurementLegendReady !== true) return;
    const operation = captureOperation(); state.aecLegendStatus = 'loading'; state.aecLegendError = null; state.aecLegendResult = null; render();
    try {
      const request = {
        sourceSha256: state.analysis.sha256,
        expectedRevision: state.domainRevision,
        measurementIds: [...state.aecMeasurementIds],
      };
      const result = validateAecMeasurementLegendResult(
        await client.generateAecMeasurementLegend(operation.documentId, request, { signal: operation.controller.signal }),
        request,
      );
      if (!operationIsCurrent(operation)) { state.aecLegendStatus = 'idle'; return; }
      state.aecLegendResult = result;
      if (typeof BlobConstructor === 'function') triggerDownload({ blob: new BlobConstructor([JSON.stringify(result, null, 2)], { type: 'application/json' }), fileName: 'aec-measurement-legend.json', message: 'Source-bound AEC measurement legend downloaded.' });
      state.aecLegendStatus = 'success'; announce('Source-bound AEC measurement legend downloaded.');
    } catch (error) { if (operationIsCurrent(operation)) { state.aecLegendStatus = error?.code === 'JOB_CANCELLED' || error?.status === 499 ? 'cancelled' : error?.code === 'REVISION_CONFLICT' || error?.code === 'SOURCE_VERSION_MISMATCH' ? 'stale' : 'error'; state.aecLegendError = error?.message ?? String(error); } }
    finally { finishOperation(operation); render(); }
  }

  return Object.freeze({
    syncAecRecordIds: (workspace) => syncAecRecordIds(state, workspace),
    createAecCalibration: calibration.createAecCalibration,
    createAecMeasurement: measurement.createAecMeasurement,
    publishAecMeasurement: publication.publishAecMeasurement,
    generateAecMeasurementLegend,
  });
}
