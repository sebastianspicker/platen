export function createScannerDiscoveryController({ state, client, captureOperation, operationIsCurrent, finishOperation, render, announce }) {
  if (!state || !client || [captureOperation, operationIsCurrent, finishOperation, render, announce].some((value) => typeof value !== 'function')) throw new TypeError('Scanner discovery controller dependencies are invalid.');
  async function discoverScanners() {
    if (state.busyAction || state.host?.scannerDiscoveryReady !== true) return;
    const operation = captureOperation(); state.scannerDiscoveryStatus = 'loading'; state.scannerDiscoveryError = null; render();
    try {
      const result = await client.discoverScanners({ signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      state.scannerDiscoveryResult = result; state.scannerDevices = result.ok ? result.result.devices : []; state.scannerDiscoveryEvidence = result.ok ? result.result.evidence : result.error.evidence; state.scannerDiscoveryStatus = 'success'; announce(`Scanner discovery completed: ${state.scannerDevices.length} device${state.scannerDevices.length === 1 ? '' : 's'} found.`);
    } catch (error) { if (operationIsCurrent(operation)) { state.scannerDiscoveryStatus = error?.code === 'JOB_CANCELLED' || error?.status === 499 ? 'cancelled' : 'error'; state.scannerDiscoveryError = error?.message ?? String(error); } }
    finally { finishOperation(operation); render(); }
  }
  async function acquireScanner(deviceId) {
    if (state.busyAction || state.host?.scannerAcquisitionReady !== true) return;
    const operation = captureOperation(); state.scannerAcquisitionStatus = 'loading'; state.scannerAcquisitionError = null; state.scannerAcquisitionResult = null; state.scannerAcquisitionEvidence = null; render();
    try {
      const result = await client.acquireScanner({ deviceId, color: 'color', dpi: 300, signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      state.scannerAcquisitionResult = result; state.scannerAcquisitionEvidence = result.evidence; state.scannerAcquisitionStatus = 'success'; announce(`Scanner acquisition completed: ${result.document.displayName} retained.`);
    } catch (error) { if (operationIsCurrent(operation)) { state.scannerAcquisitionStatus = error?.code === 'JOB_CANCELLED' || error?.status === 499 ? 'cancelled' : 'error'; state.scannerAcquisitionError = error?.message ?? String(error); } }
    finally { finishOperation(operation); render(); }
  }
  return Object.freeze({ discoverScanners, acquireScanner });
}
