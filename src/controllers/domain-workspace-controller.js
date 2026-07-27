import { createDomainOperationOperations } from './domain-workspace/domain-operation-operations.js';
import { createProjectBundleExportOperations } from './domain-workspace/project-bundle-export-operations.js';
import { createProjectBundleImportOperations } from './domain-workspace/project-bundle-import-operations.js';
import { projectBundleSummary } from './domain-workspace/project-bundle-summary.js';

export function createDomainWorkspaceController({
  state,
  client,
  getDocumentOperations,
  connectLocalHost,
  openFile,
  removeHostDocument,
  captureOperation,
  operationIsCurrent,
  finishOperation,
  syncAecRecordIds,
  triggerDownload,
  render,
  announce,
  confirmReplace = (message) => globalThis.window.confirm(message),
  File: FileCtor = globalThis.File,
}) {
  const callbacks = {
    getDocumentOperations, connectLocalHost, openFile, removeHostDocument, captureOperation,
    operationIsCurrent, finishOperation, syncAecRecordIds, triggerDownload, render, announce,
    confirmReplace,
  };
  if (!state || !client || typeof FileCtor !== 'function'
    || Object.values(callbacks).some((callback) => typeof callback !== 'function')) {
    throw new TypeError('Domain workspace controller requires state, client, file API, and callbacks.');
  }

  const dependencies = { state, client, FileCtor, ...callbacks };
  const domainOperations = createDomainOperationOperations(dependencies);
  const projectExport = createProjectBundleExportOperations(dependencies);
  const projectImport = createProjectBundleImportOperations(dependencies);

  return Object.freeze({
    selectDomainOperation: domainOperations.selectDomainOperation,
    runDomainOperation: domainOperations.runDomainOperation,
    projectBundleSummary: (workspace, kind) => projectBundleSummary(state, workspace, kind),
    exportProjectBundle: projectExport.exportProjectBundle,
    importProjectBundle: projectImport.importProjectBundle,
  });
}
