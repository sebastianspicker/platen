async function runPrepress(context, operationName) {
  const {
    state, client, captureOperation, operationIsCurrent, reportOperationError,
    finishOperation, render, announce, showError,
  } = context;
    if (!state.analysis.documentId || state.busyAction) return;
    const labels = {
      preflight: `Running the fixed ${state.preflightProfile} profile…`,
      'ink-coverage': 'Analyzing local CMYK ink coverage…',
      separations: `Rendering local separations for page ${state.selectedPage}…`,
      'overprint-preview': `Rendering local overprint preview for page ${state.selectedPage}…`,
    };
    if (!Object.hasOwn(labels, operationName)) return;
    const requestedDpi = Number(state.prepressDpi);
    if (!['ink-coverage', 'preflight'].includes(operationName)
      && (!Number.isSafeInteger(requestedDpi) || requestedDpi < 36 || requestedDpi > 300)) {
      showError(new Error('Prepress DPI must be a whole number from 36 through 300.'));
      return;
    }
    const operation = captureOperation();
    state.busyAction = labels[operationName];
    state.error = null;
    state.prepressResult = null;
    render();
    try {
      const requestOptions = operationName === 'ink-coverage'
        ? { signal: operation.controller.signal }
        : operationName === 'preflight'
          ? { profile: state.preflightProfile, signal: operation.controller.signal }
          : { page: state.selectedPage, dpi: requestedDpi, signal: operation.controller.signal };
      const result = await client.runPrepress(operation.documentId, operationName, requestOptions);
      if (!operationIsCurrent(operation)) return;
      state.prepressResult = result;
      const message = result.kind === 'preflight-review'
        ? `Fixed local preflight review completed with status ${result.status}.`
        : result.kind === 'ink-coverage'
          ? `Local CMYK coverage analyzed for ${result.pages.length} page${result.pages.length === 1 ? '' : 's'}.`
          : `${result.kind === 'separation-preview' ? 'Separation previews' : 'Overprint preview'} rendered locally for page ${result.page}.`;
      announce(message);
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
}

async function runPrepressArtifact(context, operationName, options = {}) {
  const {
    state, client, captureOperation, operationIsCurrent, reportOperationError,
    finishOperation, downloadDerivedArtifact, render,
  } = context;
    if (!state.analysis.documentId || state.busyAction) return;
    const labels = {
      'icc-convert': 'Creating CMYK ICC-derived PDF…',
      imposition: `Creating ${options.layout} imposed PDF…`,
    };
    const operation = captureOperation();
    state.busyAction = labels[operationName];
    state.error = null;
    state.prepressResult = null;
    render();
    try {
      const result = operationName === 'icc-convert'
        ? await client.convertToCmyk(operation.documentId, {
          profile: 'ghostscript-default-cmyk',
          signal: operation.controller.signal,
        })
        : await client.createImposition(operation.documentId, {
          ...options,
          signal: operation.controller.signal,
        });
      if (!operationIsCurrent(operation)) return;
      if (!result?.artifact) throw new Error('The local prepress service returned no derived artifact.');
      state.prepressResult = result;
      await downloadDerivedArtifact(
        result.artifact,
        operation,
        `${result.artifact.displayName} downloaded as a separate derived PDF. The source is unchanged.`,
      );
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
}

async function runProductionValidation(context) {
  const {
    state, client, captureOperation, operationIsCurrent, reportOperationError,
    finishOperation, render, announce,
  } = context;
    if (!state.analysis.documentId || state.busyAction) return;
    const operation = captureOperation();
    state.busyAction = 'Running local production validation…';
    state.error = null;
    state.prepressResult = null;
    render();
    try {
      const result = await client.runProductionValidation(operation.documentId, {
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation)) return;
      state.prepressResult = result;
      announce('Local production validation completed; human production review remains required.');
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
}

async function assignOutputIntent(context) {
  const {
    state, client, captureOperation, operationIsCurrent, reportOperationError,
    finishOperation, downloadDerivedArtifact, render,
  } = context;
    if (!state.analysis.documentId || state.busyAction) return;
    const operation = captureOperation();
    state.busyAction = 'Creating fixed-profile OutputIntent PDF…';
    state.error = null;
    state.prepressResult = null;
    render();
    try {
      const result = await client.assignOutputIntent(
        operation.documentId,
        {
          profile: 'local-ghostscript-default-cmyk-output-intent-v1',
          sourceSha256: state.analysis.sha256,
        },
        { signal: operation.controller.signal },
      );
      if (!operationIsCurrent(operation)) return;
      if (!result?.artifact) throw new Error('The local prepress service returned no derived OutputIntent artifact.');
      state.prepressResult = result;
      await downloadDerivedArtifact(
        result.artifact,
        operation,
        `${result.artifact.displayName} downloaded as a separate derived PDF. The source is unchanged. OutputIntent assignment does not establish PDF/X conformance.`,
      );
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
}

function exportPreflightReport({ state, jsonDownload }) {
    if (state.prepressResult?.kind !== 'preflight-review') return;
    const stem = (state.document.name || 'document').replace(/\.pdf$/i, '');
    jsonDownload(
      state.prepressResult,
      `${stem}-${state.prepressResult.profile?.id ?? 'preflight'}-review.json`,
      'Non-certifying local preflight review exported as JSON.',
    );
}

export function createPrepressOperations(context) {
  return {
    runPrepress: (name) => runPrepress(context, name),
    runPrepressArtifact: (name, options) => runPrepressArtifact(context, name, options),
    runProductionValidation: () => runProductionValidation(context),
    assignOutputIntent: () => assignOutputIntent(context),
    exportPreflightReport: () => exportPreflightReport(context),
  };
}
