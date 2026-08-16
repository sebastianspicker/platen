const ARTIFACT_CAPABILITIES = Object.freeze({
  addPdfKitTextFieldWidget: true,
  runAnnotationFlatten: true,
  runAttachmentRemoval: true,
  runIncrementalBleedBox: true,
  runIncrementalGoToLink: true,
  runIncrementalMetadata: true,
  runIncrementalNamedDestination: true,
  runIncrementalPageVector: true,
  runJavaScriptRemoval: true,
  runPageText: true,
  runPdfKitInkAnnotationMutation: true,
  runPdfKitLineAnnotationMutation: true,
  runPdfKitLocalGoToMutation: true,
  runPdfKitLocalGoToRemovalMutation: true,
  runPdfKitMutation: true,
  runPdfKitOutlineMutation: true,
  runPdfKitOutlineRemovalMutation: true,
  runPdfKitOutlineRenameMutation: true,
  runPdfKitTargetedMutation: true,
  sanitizePdfKitMetadata: true,
});

function invokeArtifactCapability(client, method, documentId, sha256, mutation, options, withoutMutation) {
  if (!Object.hasOwn(ARTIFACT_CAPABILITIES, method)) {
    throw new TypeError('Unknown PDFKit artifact capability');
  }
  const args = withoutMutation ? [documentId, sha256, options] : [documentId, sha256, mutation, options];
  if (method === 'addPdfKitTextFieldWidget') return client.addPdfKitTextFieldWidget(...args);
  if (method === 'runAnnotationFlatten') return client.runAnnotationFlatten(...args);
  if (method === 'runAttachmentRemoval') return client.runAttachmentRemoval(...args);
  if (method === 'runIncrementalBleedBox') return client.runIncrementalBleedBox(...args);
  if (method === 'runIncrementalGoToLink') return client.runIncrementalGoToLink(...args);
  if (method === 'runIncrementalMetadata') return client.runIncrementalMetadata(...args);
  if (method === 'runIncrementalNamedDestination') return client.runIncrementalNamedDestination(...args);
  if (method === 'runIncrementalPageVector') return client.runIncrementalPageVector(...args);
  if (method === 'runJavaScriptRemoval') return client.runJavaScriptRemoval(...args);
  if (method === 'runPageText') return client.runPageText(...args);
  if (method === 'runPdfKitInkAnnotationMutation') return client.runPdfKitInkAnnotationMutation(...args);
  if (method === 'runPdfKitLineAnnotationMutation') return client.runPdfKitLineAnnotationMutation(...args);
  if (method === 'runPdfKitLocalGoToMutation') return client.runPdfKitLocalGoToMutation(...args);
  if (method === 'runPdfKitLocalGoToRemovalMutation') return client.runPdfKitLocalGoToRemovalMutation(...args);
  if (method === 'runPdfKitMutation') return client.runPdfKitMutation(...args);
  if (method === 'runPdfKitOutlineMutation') return client.runPdfKitOutlineMutation(...args);
  if (method === 'runPdfKitOutlineRemovalMutation') return client.runPdfKitOutlineRemovalMutation(...args);
  if (method === 'runPdfKitOutlineRenameMutation') return client.runPdfKitOutlineRenameMutation(...args);
  if (method === 'runPdfKitTargetedMutation') return client.runPdfKitTargetedMutation(...args);
  return client.sanitizePdfKitMetadata(...args);
}

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
      const result = await invokeArtifactCapability(
        client,
        method,
        operation.documentId,
        state.analysis.sha256,
        mutation,
        { signal: operation.controller.signal },
        withoutMutation,
      );
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
