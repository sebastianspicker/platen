export function createPdfKitArtifactRunner({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  render,
  downloadDerivedArtifact,
  downloadEphemeralDerivedArtifact,
}) {
  function ready(capability, requireInspection = false) {
    return state.analysis.documentId && state.analysis.sha256 && !state.busyAction
      && state.host?.[capability]
      && (!requireInspection || state.pdfkitInspectionResult?.sourceDigest === state.analysis.sha256);
  }

  async function runArtifact({ method, mutation, busyAction, message, resultKey, ephemeral = false, withoutMutation = false }) {
    const operation = captureOperation();
    state.busyAction = busyAction;
    state.error = null;
    state[resultKey] = null;
    render();
    try {
      const result = withoutMutation
        ? await client[method](operation.documentId, state.analysis.sha256, { signal: operation.controller.signal })
        : await client[method](operation.documentId, state.analysis.sha256, mutation, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      const download = ephemeral ? downloadEphemeralDerivedArtifact : downloadDerivedArtifact;
      const downloaded = await download(result.artifact, operation, message(result));
      if (downloaded && operationIsCurrent(operation)) state[resultKey] = result;
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  return { ready, runArtifact };
}
