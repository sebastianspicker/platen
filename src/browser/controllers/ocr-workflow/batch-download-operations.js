export function createOcrBatchDownloadOperations({
  state,
  client,
  removeHostDocument,
  triggerDownload,
  render,
  showError,
}) {
  async function downloadOcrBatchArtifact(id) {
    const item = state.ocrBatchResult?.items?.find((entry) => entry.id === Number(id));
    if (!item?.artifact?.id || state.busyAction) return;
    try {
      state.busyAction = `Fetching ${item.name} OCR artifact…`;
      render();
      const blob = await client.artifact(item.artifact.id);
      triggerDownload({
        blob,
        fileName: item.artifact.displayName
          || `${item.name.replace(/\.pdf$/i, '')}-searchable-ocr.pdf`,
        message: `OCR artifact ready for ${item.name}.`,
      });
      item.downloaded = true;
      void removeHostDocument(item.documentId);
    } catch (error) {
      showError(error);
    } finally {
      state.busyAction = null;
      render();
    }
  }

  function exportOcrBatchManifest() {
    const manifest = state.ocrBatchResult?.manifest;
    if (!manifest) return;
    triggerDownload({
      blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
      fileName: 'ocr-batch-manifest.json',
      message: 'Local OCR batch manifest exported.',
    });
  }

  return { downloadOcrBatchArtifact, exportOcrBatchManifest };
}
