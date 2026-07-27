export function createPageArtifactOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  removeHostDocument,
  downloadDerivedArtifact,
  triggerDownload,
  render,
}) {
  async function insertBlankPage() {
    if (!state.analysis.documentId || state.busyAction) return;
    const operation = captureOperation();
    const afterPage = state.selectedPage;
    state.busyAction = `Inserting a blank page after page ${afterPage}…`;
    state.error = null;
    render();
    let blank = null;
    try {
      blank = await client.createBlank(
        { pages: 1, title: 'Inserted blank page' },
        { signal: operation.controller.signal },
      );
      if (!operationIsCurrent(operation)) return;
      const artifact = await client.insertDocument(
        operation.documentId,
        blank.id,
        afterPage,
        { signal: operation.controller.signal },
      );
      if (!operationIsCurrent(operation)) return;
      await downloadDerivedArtifact(
        artifact,
        operation,
        `A blank page was inserted after page ${afterPage} in a new PDF.`,
      );
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      if (blank?.id) await removeHostDocument(blank.id);
      finishOperation(operation);
    }
  }

  async function extractSelectedPage() {
    if (!state.analysis.documentId || state.busyAction) return;
    const operation = captureOperation();
    const selectedPage = state.selectedPage;
    state.busyAction = `Extracting page ${selectedPage}…`;
    state.error = null;
    render();
    try {
      const artifact = await client.extractPages(operation.documentId, [selectedPage], {
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation)) return;
      const blob = await client.artifact(artifact.id, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      triggerDownload({
        blob,
        fileName: artifact.displayName,
        message: `Page ${selectedPage} extracted as a new PDF.`,
      });
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  async function duplicateSelectedPage() {
    if (!state.analysis.documentId || state.busyAction) return;
    const operation = captureOperation();
    const selectedPage = state.selectedPage;
    state.busyAction = `Duplicating page ${selectedPage}…`;
    state.error = null;
    render();
    try {
      const artifact = await client.duplicatePages(operation.documentId, [selectedPage], {
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation)) return;
      await downloadDerivedArtifact(artifact, operation, `Page ${selectedPage} duplicated in a new PDF.`);
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  async function reverseDocumentPages() {
    if (!state.analysis.documentId || state.busyAction) return;
    const operation = captureOperation();
    state.busyAction = 'Reversing page order…';
    state.error = null;
    render();
    try {
      const artifact = await client.reversePages(operation.documentId, {
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation)) return;
      await downloadDerivedArtifact(
        artifact,
        operation,
        'Reversed-page PDF exported. The source is unchanged.',
      );
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  return { insertBlankPage, extractSelectedPage, duplicateSelectedPage, reverseDocumentPages };
}
