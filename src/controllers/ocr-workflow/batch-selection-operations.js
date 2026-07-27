export function createOcrBatchSelectionOperations({
  state,
  removeHostDocument,
  render,
  showError,
  maxBatchRequests,
}) {
  function setOcrBatchFiles(fileList) {
    const files = Array.from(fileList ?? []);
    if (files.length < 1 || files.length > maxBatchRequests
      || files.some((file) => !/\.pdf$/i.test(file.name) && file.type !== 'application/pdf')) {
      state.ocrBatchFiles = [];
      showError(new Error(
        `Choose 1 through ${maxBatchRequests} PDF files for OCR batch processing.`,
      ));
      return false;
    }
    for (const documentId of state.ocrBatchTemporaryDocumentIds) {
      void removeHostDocument(documentId);
    }
    state.ocrBatchFiles = files;
    state.ocrBatchResult = null;
    render();
    return true;
  }

  return { setOcrBatchFiles };
}
