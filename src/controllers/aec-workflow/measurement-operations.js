import { newAecId } from './identifier.js';

export function createAecMeasurementOperations({
  state,
  client,
  cryptoApi,
  captureOperation,
  operationIsCurrent,
  finishOperation,
  render,
  announce,
  parseAecPoints,
}) {
  async function createAecMeasurement() {
    if (!state.analysis.documentId || state.domainBusy || state.busyAction) return;
    const operation = captureOperation();
    state.domainBusy = true;
    state.domainError = null;
    state.domainResult = null;
    render();
    try {
      const kind = state.aecMeasurementKind;
      const result = await client.measureAec(operation.documentId, {
        schemaVersion: 1,
        sourceSha256: state.analysis.sha256,
        expectedRevision: state.domainRevision,
        id: newAecId(cryptoApi, 'measurement'),
        page: state.selectedPage,
        kind,
        points: parseAecPoints(state.aecMeasurementPoints),
        calibrationId: kind === 'count' ? null : state.aecLastCalibrationId,
        label: state.aecMeasurementLabel,
        displayUnit: state.aecDisplayUnit,
      }, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      state.domainRevision = result.workspaceRevision;
      state.aecLastMeasurementId = result.measurement.id;
      state.aecLegendStatus = 'idle'; state.aecLegendError = null; state.aecLegendResult = null;
      state.domainResult = result;
      announce(`${result.measurement.result.displayValue} ${result.measurement.result.displayUnit} recorded as source-bound AEC evidence.`);
    } catch (error) {
      if (operationIsCurrent(operation)) {
        state.domainError = operation.controller.signal.aborted
          ? 'AEC measurement was cancelled.'
          : error.message;
      }
    } finally {
      if (operationIsCurrent(operation)) state.domainBusy = false;
      finishOperation(operation);
    }
  }

  return { createAecMeasurement };
}
