import { createArrangementOperations } from './page-composition/arrangement-operations.js';
import { createPageArtifactOperations } from './page-composition/page-artifact-operations.js';
import { createSecondaryCompositionOperations } from './page-composition/secondary-composition-operations.js';
import { createSplitOperations } from './page-composition/split-operations.js';

export function createPageCompositionController({
  state,
  client,
  captureOperation,
  operationIsCurrent,
  reportOperationError,
  finishOperation,
  getActiveController,
  removeHostDocument,
  downloadDerivedArtifact,
  triggerDownload,
  selectPage,
  setSelectedPageIdentity,
  render,
  announce,
  showError,
  document: browserDocument = globalThis.document,
}) {
  const callbacks = {
    captureOperation,
    operationIsCurrent,
    reportOperationError,
    finishOperation,
    getActiveController,
    removeHostDocument,
    downloadDerivedArtifact,
    triggerDownload,
    selectPage,
    setSelectedPageIdentity,
    render,
    announce,
    showError,
  };
  if (!state || !client || Object.values(callbacks).some((callback) => typeof callback !== 'function')) {
    throw new TypeError('Page composition controller requires state, client, and workflow callbacks.');
  }

  const dependencies = { state, client, browserDocument, ...callbacks };
  const arrangement = createArrangementOperations(dependencies);
  const pageArtifacts = createPageArtifactOperations(dependencies);
  const secondaryComposition = createSecondaryCompositionOperations(dependencies);
  const splitting = createSplitOperations(dependencies);

  return Object.freeze({
    insertBlankPage: pageArtifacts.insertBlankPage,
    extractSelectedPage: pageArtifacts.extractSelectedPage,
    arrangementChanged: arrangement.arrangementChanged,
    moveSelectedPage: arrangement.moveSelectedPage,
    removeSelectedPage: arrangement.removeSelectedPage,
    restorePageOrder: arrangement.restorePageOrder,
    exportArrangement: arrangement.exportArrangement,
    runSecondaryComposition: secondaryComposition.runSecondaryComposition,
    mergeFile: secondaryComposition.mergeFile,
    appendScannedPage: secondaryComposition.appendScannedPage,
    splitDocument: splitting.splitDocument,
    splitDocumentByRule: splitting.splitDocumentByRule,
    splitVerifiedTopLevelOutline: splitting.splitVerifiedTopLevelOutline,
    duplicateSelectedPage: pageArtifacts.duplicateSelectedPage,
    reverseDocumentPages: pageArtifacts.reverseDocumentPages,
  });
}
