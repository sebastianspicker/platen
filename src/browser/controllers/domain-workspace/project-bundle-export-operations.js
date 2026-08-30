import { PORTABLE_PROJECT_BUNDLE_MAX_BYTES, projectBundleSummary } from './project-bundle-summary.js';

export function createProjectBundleExportOperations({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  finishOperation,
  triggerDownload,
  render,
}) {
  async function exportProjectBundle() {
    if (!state.analysis.documentId || state.domainBusy || state.busyAction) return;
    const operation = captureOperation();
    state.domainBusy = true;
    state.domainError = null;
    state.domainResult = null;
    render();
    try {
      const [bundle, workspace] = await Promise.all([
        client.exportPortableProjectBundle(operation.documentId, {
          signal: operation.controller.signal,
        }),
        client.workspace(operation.documentId, { signal: operation.controller.signal }),
      ]);
      if (!operationIsCurrent(operation)) return;
      const byteLength = bundle.size;
      if (!Number.isSafeInteger(byteLength) || byteLength < 1
        || byteLength > PORTABLE_PROJECT_BUNDLE_MAX_BYTES) {
        throw new Error('The portable local project exceeds its bounded size limit.');
      }
      const stem = (state.document.name || 'document').replace(/\.pdf$/i, '');
      triggerDownload({
        blob: bundle,
        fileName: `${stem}.platen-project`,
        message: 'Self-contained local project exported with the exact PDF and its digest-bound workspace.',
      });
      state.domainResult = {
        ...projectBundleSummary(state, workspace, 'portable-project-export'),
        byteLength,
        includesPdfBytes: true,
      };
    } catch (error) {
      if (operationIsCurrent(operation)) {
        state.domainError = operation.controller.signal.aborted
          ? 'Project bundle export was cancelled.'
          : error.message;
      }
    } finally {
      if (operationIsCurrent(operation)) state.domainBusy = false;
      finishOperation(operation);
    }
  }

  return { exportProjectBundle };
}
