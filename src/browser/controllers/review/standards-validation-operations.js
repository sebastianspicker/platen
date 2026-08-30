export function createStandardsValidationOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  render,
  announce,
  jsonDownload,
}) {
  async function runStandardsValidation() {
    if (!state.analysis.documentId || state.busyAction || !state.host?.standardsValidationReady) return;
    const operation = captureOperation();
    state.busyAction = `Validating ${state.standardsProfile} with the pinned local standards engine…`;
    state.error = null;
    state.standardsValidationResult = null;
    render();
    try {
      const result = await client.runStandardsValidation(
        operation.documentId,
        state.standardsProfile,
        { signal: operation.controller.signal },
      );
      if (!operationIsCurrent(operation)) return;
      state.standardsValidationResult = result;
      announce(`${result.standard.profile} validation completed: ${result.status}.`);
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  function exportStandardsValidation() {
    if (state.standardsValidationResult?.kind !== 'standards-validation') return;
    const stem = (state.document.name || 'document').replace(/\.pdf$/i, '');
    jsonDownload(
      state.standardsValidationResult,
      `${stem}-${state.standardsValidationResult.standard.profile}-validation.json`,
      'Source-bound standards validation receipt exported as JSON.',
    );
  }

  return { runStandardsValidation, exportStandardsValidation };
}
