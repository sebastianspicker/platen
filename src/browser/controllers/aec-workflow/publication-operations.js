export function createAecPublicationOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  finishOperation,
  downloadDerivedArtifact,
  render,
  confirm,
}) {
  async function publishAecMeasurement() {
    if (!state.analysis.documentId || !state.aecLastMeasurementId || state.domainBusy
      || state.busyAction || !state.host?.aecNativeReady) return;
    if (!confirm('Create a separate PDF with inert native AEC annotations and a bounded calibrated Measure dictionary where applicable? Count remains uncalibrated and the source PDF remains unchanged.')) return;
    const operation = captureOperation();
    state.domainBusy = true;
    state.domainError = null;
    state.domainResult = null;
    render();
    try {
      const result = await client.materializeAec(operation.documentId, {
        schemaVersion: 1,
        sourceSha256: state.analysis.sha256,
        expectedRevision: state.domainRevision,
        measurementId: state.aecLastMeasurementId,
      }, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      const downloaded = await downloadDerivedArtifact(
        result.artifact,
        operation,
        'Source-bound AEC measurement published as a separate validated PDF annotation artifact.',
      );
      if (downloaded && operationIsCurrent(operation)) state.domainResult = result;
    } catch (error) {
      if (operationIsCurrent(operation)) {
        state.domainError = operation.controller.signal.aborted
          ? 'AEC publication was cancelled.'
          : error.message;
      }
    } finally {
      if (operationIsCurrent(operation)) state.domainBusy = false;
      finishOperation(operation);
    }
  }

  return { publishAecMeasurement };
}
