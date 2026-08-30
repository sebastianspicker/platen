export function createHostDocumentController({ state, client }) {
  async function removeHostDocument(documentId) {
    if (!documentId || !client.connected) return;
    try {
      await client.deleteDocument(documentId);
      state.ocrBatchTemporaryDocumentIds = state.ocrBatchTemporaryDocumentIds.filter(
        (id) => id !== documentId,
      );
    } catch {
      // The host owns a private per-process temp root and will clean it on shutdown.
    }
  }

  return Object.freeze({ removeHostDocument });
}
