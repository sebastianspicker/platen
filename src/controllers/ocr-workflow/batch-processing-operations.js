export function createOcrBatchProcessingOperations({
  state,
  client,
  getDocumentOperations,
  removeHostDocument,
  render,
  announce,
  showError,
  maxBatchRequests,
}) {
  async function runOcrBatch() {
    const files = state.ocrBatchFiles;
    if (state.busyAction || !Array.isArray(files) || files.length < 1
      || files.length > maxBatchRequests || !state.ocrLanguages.includes(state.ocrLanguage)) return;
    const controller = new AbortController();
    const documentOperations = getDocumentOperations();
    documentOperations.activeController = controller;
    state.busyAction = `Uploading ${files.length} PDF${files.length === 1 ? '' : 's'} for local OCR…`;
    state.canCancel = true;
    state.error = null;
    state.ocrBatchResult = null;
    await Promise.all(
      [...state.ocrBatchTemporaryDocumentIds].map((documentId) => removeHostDocument(documentId)),
    );
    state.ocrBatchTemporaryDocumentIds = [];
    render();
    const uploaded = [];
    try {
      for (const file of files) {
        const document = await client.upload(file, { signal: controller.signal });
        uploaded.push(document);
        state.ocrBatchTemporaryDocumentIds.push(document.id);
      }
      state.busyAction = `Running local OCR for ${uploaded.length} PDF${uploaded.length === 1 ? '' : 's'}…`;
      render();
      const response = await client.ocrBatch({
        requests: uploaded.map((document, index) => ({
          id: index + 1,
          documentId: document.id,
          kind: 'document',
          options: {
            language: state.ocrLanguage,
            cleanupPreset: state.ocrCleanupPreset,
            segmentation: state.ocrSegmentation,
            userDictionary: state.ocrUserDictionary.split(/\r?\n/u).filter((term) => term.trim()),
          },
        })),
      }, state.ocrLanguages, { signal: controller.signal });
      const items = response.results.map((result, index) => ({
        ...result,
        name: files[index].name,
        documentId: uploaded[index].id,
      }));
      state.ocrBatchResult = { manifest: response.manifest, items };
      for (const item of items) {
        if (item.status !== 'completed') void removeHostDocument(item.documentId);
      }
      const completed = items.filter((item) => item.status === 'completed').length;
      announce(`Local OCR batch ${response.manifest.status}: ${completed} completed of ${items.length}. Select each artifact to download it.`);
    } catch (error) {
      for (const document of uploaded) void removeHostDocument(document.id);
      showError(error);
    } finally {
      if (documentOperations.activeController === controller) documentOperations.activeController = null;
      state.busyAction = null;
      state.canCancel = false;
      render();
    }
  }

  return { runOcrBatch };
}
