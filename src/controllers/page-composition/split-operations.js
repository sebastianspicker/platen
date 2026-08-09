export function createSplitOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  downloadDerivedArtifact,
  render,
  announce,
  showError,
}) {
  async function downloadArtifactInventory(artifacts, operation, message) {
    for (const [index, artifact] of artifacts.entries()) {
      const completed = await downloadDerivedArtifact(
        artifact,
        operation,
        message(index, artifacts.length),
      );
      if (!completed) return false;
    }
    return true;
  }

  async function splitDocument() {
    if (!state.analysis.documentId || state.busyAction) return;
    const operation = captureOperation();
    const sourceSha256 = state.analysis.sha256;
    state.busyAction = 'Splitting PDF into individual page files…';
    state.error = null;
    render();
    try {
      const artifacts = await client.splitDocument(operation.documentId, sourceSha256, {
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation)) return;
      if (!(await downloadArtifactInventory(
        artifacts,
        operation,
        (index, total) => `Downloading split page ${index + 1} of ${total}.`,
      ))) return;
      announce(`Split complete. ${artifacts.length} separate PDF${artifacts.length === 1 ? '' : 's'} downloaded.`);
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  async function splitDocumentByRule() {
    if (!state.analysis.documentId || state.busyAction) return;
    const pagesPerOutput = Number(state.splitRulePages);
    if (!Number.isSafeInteger(pagesPerOutput) || pagesPerOutput < 1 || pagesPerOutput > 500) {
      showError(new Error('Pages per split file must be an integer from 1 through 500.'));
      return;
    }
    const operation = captureOperation();
    const sourceSha256 = state.analysis.sha256;
    state.busyAction = `Splitting the PDF every ${pagesPerOutput} page${pagesPerOutput === 1 ? '' : 's'}…`;
    state.error = null;
    render();
    try {
      const artifacts = await client.splitByPageCount(
        operation.documentId,
        sourceSha256,
        pagesPerOutput,
        { signal: operation.controller.signal },
      );
      if (!operationIsCurrent(operation)) return;
      if (!(await downloadArtifactInventory(
        artifacts,
        operation,
        (index, total) => `Downloading rule split ${index + 1} of ${total}.`,
      ))) return;
      announce(`Rule split complete. ${artifacts.length} validated PDF${artifacts.length === 1 ? '' : 's'} downloaded.`);
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  async function splitVerifiedTopLevelOutline() {
    if (!state.analysis.documentId || !state.host?.pdfkitOutlineSplitReady || state.busyAction) return;
    const operation = captureOperation();
    state.busyAction = 'Re-inspecting and splitting at verified top-level bookmarks…';
    state.error = null;
    render();
    let initiatedDownloads = 0;
    try {
      const artifacts = await client.splitByVerifiedTopLevelOutline(operation.documentId, {
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation)) return;
      for (const [index, artifact] of artifacts.entries()) {
        const completed = await downloadDerivedArtifact(
          artifact,
          operation,
          `Download request started for verified bookmark split ${index + 1} of ${artifacts.length}.`,
        );
        if (!completed) return;
        initiatedDownloads += 1;
      }
      announce(`Verified bookmark split complete. ${artifacts.length} validated PDF download requests started.`);
    } catch (error) {
      reportOperationError(error, operation);
      if (initiatedDownloads > 0 && operationIsCurrent(operation)) {
        announce(`${initiatedDownloads} validated PDF download request${initiatedDownloads === 1 ? '' : 's'} started before the remaining bookmark-split downloads stopped.`);
      }
    } finally {
      finishOperation(operation);
    }
  }

  return { splitDocument, splitDocumentByRule, splitVerifiedTopLevelOutline };
}
