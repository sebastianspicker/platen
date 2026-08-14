export function createOcrPageAnalysisOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  render,
  announce,
  showError,
  clearOcrLayoutSelection,
  normalizedCurrentPageOcrZones,
}) {
  async function analyzeSelectedPageOcr() {
    if (!state.analysis.documentId || !state.ocrLanguages.includes(state.ocrLanguage)
      || state.busyAction) return;
    let zones;
    try {
      zones = normalizedCurrentPageOcrZones();
    } catch (error) {
      showError(error);
      return;
    }
    const operation = captureOperation();
    const selectedPage = state.selectedPage;
    state.busyAction = zones.length
      ? `Analyzing ${zones.length} OCR zone${zones.length === 1 ? '' : 's'} on page ${selectedPage}…`
      : `Analyzing the full page ${selectedPage}…`;
    state.error = null;
    clearOcrLayoutSelection();
    render();
    try {
      const result = await client.analyzeOcrLayout(operation.documentId, {
        language: state.ocrLanguage,
        pages: [selectedPage],
        zones,
        cleanupPreset: state.ocrCleanupPreset,
        segmentation: state.ocrSegmentation,
        detectTables: state.ocrDetectTables,
      }, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      state.ocrLayoutResult = result;
      const records = Array.isArray(result?.records) ? result.records : [];
      state.selectedOcrRecordIndex = records.length === 1 ? 0 : null;
      const recognizedWords = records.reduce(
        (total, record) => total + (Number(record?.recognizedWordCount) || 0),
        0,
      );
      const tableCandidates = records.reduce(
        (total, record) => total
          + (Array.isArray(record?.tableCandidates) ? record.tableCandidates.length : 0),
        0,
      );
      announce(`Local OCR layout ready: ${recognizedWords} recognized word${recognizedWords === 1 ? '' : 's'} and ${tableCandidates} table candidate${tableCandidates === 1 ? '' : 's'} for review.`);
    } catch (error) {
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  return { analyzeSelectedPageOcr };
}
