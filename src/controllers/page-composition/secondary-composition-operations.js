const SCAN_PAGE_SOURCE = 1;

function cleanupErrorAllowed(error) {
  return error?.code === 'DOCUMENT_NOT_FOUND' || error?.code === 'INPUT_NOT_FOUND';
}

async function cleanupScanSource({ client, removeHostDocument }, { documentId, inputId }) {
  const cleanupTasks = [
    documentId ? () => removeHostDocument(documentId) : null,
    inputId ? () => client.deleteInput(inputId, { keepalive: true }) : null,
  ].filter(Boolean);
  const outcomes = await Promise.allSettled(
    cleanupTasks.map((cleanup) => Promise.resolve().then(cleanup)),
  );
  const failures = outcomes
    .filter(({ status, reason }) => status === 'rejected' && !cleanupErrorAllowed(reason))
    .map(({ reason }) => reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Temporary scan resources could not be removed.');
  }
}

async function runSecondaryComposition({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  getActiveController,
  removeHostDocument,
  downloadDerivedArtifact,
  render,
  browserDocument,
}, file, mode) {
    if (!state.analysis.documentId || !file || state.busyAction) return;
    const operation = captureOperation();
    const selectedPage = state.selectedPage;
    const primarySourceSha256 = state.analysis.sha256;
    const copySourcePage = Number(state.copySourcePage);
    const labels = {
      merge: `Merging ${file.name || 'local PDF'}…`,
      interleave: `Interleaving ${file.name || 'local PDF'}…`,
      insert: `Inserting ${file.name || 'local PDF'} after page ${selectedPage}…`,
      replace: `Replacing page ${selectedPage} with ${file.name || 'local PDF'}…`,
      'copy-page': `Copying page ${copySourcePage} from ${file.name || 'local PDF'} after page ${selectedPage}…`,
    };
    state.busyAction = labels[mode] ?? 'Composing PDFs…';
    state.error = null;
    render();
    let secondary = null;
    try {
      secondary = await client.upload(file, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      const requests = {
        merge: () => client.mergeDocuments(operation.documentId, secondary.id, {
          signal: operation.controller.signal,
        }),
        interleave: () => client.interleaveDocuments(operation.documentId, secondary.id, {
          signal: operation.controller.signal,
        }),
        insert: () => client.insertDocument(operation.documentId, secondary.id, selectedPage, {
          signal: operation.controller.signal,
        }),
        replace: () => client.replacePages(
          operation.documentId,
          secondary.id,
          selectedPage,
          selectedPage,
          { signal: operation.controller.signal },
        ),
        'copy-page': () => client.copyPageBetweenDocuments(
          operation.documentId,
          secondary.id,
          {
            primarySourceSha256,
            secondarySourceSha256: secondary.sha256,
            sourcePage: copySourcePage,
            afterPage: selectedPage,
          },
          { signal: operation.controller.signal },
        ),
      };
      const request = requests[mode];
      if (!request) throw new Error('Unknown local composition mode.');
      const artifact = await request();
      if (!operationIsCurrent(operation)) return;
      const messages = {
        merge: 'Merged PDF exported. Both source documents are unchanged.',
        interleave: 'Interleaved PDF exported. Both source documents are unchanged.',
        insert: `Inserted PDF exported after page ${selectedPage}. Both sources are unchanged.`,
        replace: `Replacement PDF exported for page ${selectedPage}. Both sources are unchanged.`,
        'copy-page': `Copied page ${copySourcePage} after page ${selectedPage} in a derived PDF. Both sources are unchanged.`,
      };
      await downloadDerivedArtifact(artifact, operation, messages[mode]);
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      if (secondary?.id) await removeHostDocument(secondary.id);
      if (operationIsCurrent(operation) && getActiveController() === operation.controller) {
        const picker = browserDocument?.querySelector?.(`#${mode}-picker`);
        if (picker) picker.value = '';
      }
      finishOperation(operation);
    }
}

async function appendScannedPage({
  state, client, captureOperation, operationIsCurrent, reportOperationError,
  finishOperation, getActiveController, downloadDerivedArtifact, render,
  browserDocument, removeHostDocument,
}, file) {
    const imageMagickReady = state.host?.engines?.some(
      ({ name, available }) => name === 'magick' && available === true,
    );
    if (!state.analysis.documentId || state.analysis.status !== 'ready'
      || state.host?.status !== 'ready' || state.host?.conversionReady !== true
      || !imageMagickReady || !file || state.busyAction) return;
    const operation = captureOperation();
    const selectedPage = state.selectedPage;
    const primarySourceSha256 = state.analysis.sha256;
    state.busyAction = `Converting ${file.name || 'scan'} and appending page ${SCAN_PAGE_SOURCE} after page ${selectedPage}…`;
    state.error = null;
    render();
    const temporary = { inputId: null, documentId: null };
    let artifact = null;
    let operationError = null;
    try {
      const input = await client.uploadInput(file, { signal: operation.controller.signal });
      temporary.inputId = input.id;
      if (!operationIsCurrent(operation)) return;
      const artifactSource = await client.convertInput(input.id, { signal: operation.controller.signal });
      temporary.documentId = artifactSource.id;
      if (!operationIsCurrent(operation)) return;
      if (artifactSource?.operation?.validation?.pageCount !== 1) {
        const error = new Error('Scanned file conversion must produce exactly one page.');
        error.code = 'INVALID_SCAN_OUTPUT';
        throw error;
      }
      artifact = await client.copyPageBetweenDocuments(
        operation.documentId,
        artifactSource.id,
        {
          primarySourceSha256,
          secondarySourceSha256: artifactSource.sha256,
          sourcePage: SCAN_PAGE_SOURCE,
          afterPage: selectedPage,
        },
        { signal: operation.controller.signal },
      );
    } catch (error) {
      operationError = error;
    } finally {
      try {
        await cleanupScanSource({ client, removeHostDocument }, temporary);
      } catch (cleanupError) {
        operationError = operationError
          ? new AggregateError(
            [operationError, cleanupError],
            'Scan append and temporary-resource cleanup failed.',
          )
          : cleanupError;
      }
      if (operationError) {
        reportOperationError(operationError, operation);
      } else if (artifact && operationIsCurrent(operation)) {
        try {
          await downloadDerivedArtifact(
            artifact,
            operation,
            `Scanned page ${SCAN_PAGE_SOURCE} appended after page ${selectedPage} in a derived PDF. Both sources are unchanged.`,
          );
        } catch (error) {
          reportOperationError(error, operation);
        }
      }
      if (operationIsCurrent(operation) && getActiveController() === operation.controller) {
        const picker = browserDocument?.querySelector?.('#scan-append-picker');
        if (picker) picker.value = '';
      }
      finishOperation(operation);
    }
}

export function createSecondaryCompositionOperations(context) {
  const run = (file, mode) => runSecondaryComposition(context, file, mode);
  return {
    runSecondaryComposition: run,
    mergeFile: (file) => run(file, 'merge'),
    appendScannedPage: (file) => appendScannedPage(context, file),
  };
}
