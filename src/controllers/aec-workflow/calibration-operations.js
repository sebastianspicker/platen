import { newAecId } from './identifier.js';

export function createAecCalibrationOperations({
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
  async function createAecCalibration() {
    if (!state.analysis.documentId || state.domainBusy || state.busyAction) return;
    const operation = captureOperation();
    state.domainBusy = true;
    state.domainError = null;
    state.domainResult = null;
    render();
    try {
      const result = await client.calibrateAec(operation.documentId, {
        schemaVersion: 1,
        sourceSha256: state.analysis.sha256,
        expectedRevision: state.domainRevision,
        id: newAecId(cryptoApi, 'calibration'),
        page: state.selectedPage,
        points: parseAecPoints(state.aecCalibrationPoints),
        realLength: Number(state.aecRealLength),
        unit: state.aecCalibrationUnit,
        label: `${state.aecMeasurementLabel} scale`,
      }, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      state.domainRevision = result.workspaceRevision;
      state.aecLastCalibrationId = result.calibration.id;
      state.domainResult = result;
      announce('Source-bound AEC scale calibration recorded locally.');
    } catch (error) {
      if (operationIsCurrent(operation)) {
        state.domainError = operation.controller.signal.aborted
          ? 'AEC calibration was cancelled.'
          : error.message;
      }
    } finally {
      if (operationIsCurrent(operation)) state.domainBusy = false;
      finishOperation(operation);
    }
  }

  return { createAecCalibration };
}
