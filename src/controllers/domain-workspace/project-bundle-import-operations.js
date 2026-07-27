import { PORTABLE_PROJECT_BUNDLE_MAX_BYTES, projectBundleSummary } from './project-bundle-summary.js';

export function createProjectBundleImportOperations({
  state,
  client,
  FileCtor,
  getDocumentOperations,
  connectLocalHost,
  openFile,
  removeHostDocument,
  syncAecRecordIds,
  render,
  announce,
  confirmReplace,
}) {
  async function importProjectBundle(file) {
    if (!file || state.domainBusy || state.busyAction) return;
    const controller = new AbortController();
    const documentOperations = getDocumentOperations();
    documentOperations.activeController = controller;
    state.canCancel = true;
    state.domainBusy = true;
    state.domainError = null;
    state.domainResult = null;
    render();
    let importedDocumentId = null;
    try {
      if (!Number.isSafeInteger(file.size) || file.size < 1
        || file.size > PORTABLE_PROJECT_BUNDLE_MAX_BYTES) {
        throw new Error('Choose a non-empty portable project within the local size limit.');
      }
      await connectLocalHost();
      const imported = await client.importPortableProjectBundle(file, {
        signal: controller.signal,
      });
      importedDocumentId = imported.document.id;
      const [pdf, sidecar] = await Promise.all([
        client.documentSource(imported.document.id, { signal: controller.signal }),
        client.exportProjectBundle(imported.document.id, { signal: controller.signal }),
      ]);
      if (state.document?.isOpen && !confirmReplace(
        'The portable project is fully validated. Replace the currently open local document with this new project?',
      )) return;
      const importedFile = new FileCtor(
        [pdf],
        imported.document.displayName || 'portable-project.pdf',
        { type: 'application/pdf' },
      );
      await removeHostDocument(importedDocumentId);
      importedDocumentId = null;
      if (documentOperations.activeController === controller) documentOperations.activeController = null;
      state.canCancel = false;
      await openFile(importedFile);
      if (!state.analysis.documentId || state.analysis.sha256 !== imported.document.sha256) {
        throw new Error('The imported project PDF could not be reopened with the same source digest.');
      }
      const workspace = await client.importProjectBundle(
        state.analysis.documentId,
        sidecar,
        state.domainRevision,
        { signal: controller.signal },
      );
      state.domainRevision = workspace.revision;
      syncAecRecordIds(workspace);
      state.domainResult = {
        ...projectBundleSummary(state, workspace, 'portable-project-import'),
        includesPdfBytes: true,
      };
      state.view = 'workflows';
      announce('Self-contained local project opened with its exact PDF and restored workspace.');
    } catch (error) {
      state.domainError = controller.signal.aborted
        ? 'Portable project import was cancelled.'
        : error.message;
    } finally {
      if (importedDocumentId) await removeHostDocument(importedDocumentId);
      if (documentOperations.activeController === controller) documentOperations.activeController = null;
      state.canCancel = false;
      state.domainBusy = false;
      render();
    }
  }

  return { importProjectBundle };
}
