import { createPdfKitArtifactRunner } from './pdfkit-workflow/artifact-runner.js';
import { createPdfKitInspectionOperations } from './pdfkit-workflow/inspection-operations.js';
import { createPdfKitMutationOperations } from './pdfkit-workflow/mutation-operations.js';
import { createPdfKitProtectionOperations } from './pdfkit-workflow/protection-operations.js';
import { createPdfKitLayerOperations } from './pdfkit-workflow/layer-operations.js';

export function createPdfKitWorkflowController({
  state, client, captureOperation, operationIsCurrent, reportOperationError,
  finishOperation, render, announce, showError, downloadDerivedArtifact,
  downloadEphemeralDerivedArtifact, document: browserDocument = globalThis.document,
  confirm = globalThis.window?.confirm?.bind(globalThis.window), Blob: BlobConstructor = Blob,
  JSON: json = JSON, triggerDownload,
}) {
  const dependencies = {
    state, client, captureOperation, operationIsCurrent, reportOperationError, finishOperation, render,
    announce, showError, downloadDerivedArtifact, downloadEphemeralDerivedArtifact, browserDocument,
    confirm, BlobConstructor, json, triggerDownload,
  };
  const artifactRunner = createPdfKitArtifactRunner(dependencies);
  const layers = createPdfKitLayerOperations({ ...dependencies, downloadDerivedArtifact });
  const inspection = createPdfKitInspectionOperations({ ...dependencies, syncLayerInspection: layers.syncLayerInspection });
  const mutations = createPdfKitMutationOperations({ ...dependencies, ...artifactRunner });
  const protection = createPdfKitProtectionOperations({ ...dependencies, ...artifactRunner });

  return Object.freeze({
    runPdfKitInspection: inspection.runPdfKitInspection,
    runAnnotationFlatten: mutations.runAnnotationFlatten,
    runAttachmentRemoval: mutations.runAttachmentRemoval,
    runIncrementalBleedBox: mutations.runIncrementalBleedBox,
    runIncrementalGoToLink: mutations.runIncrementalGoToLink,
    runIncrementalNamedDestination: mutations.runIncrementalNamedDestination,
    runIncrementalMetadata: mutations.runIncrementalMetadata,
    runIncrementalPageVector: mutations.runIncrementalPageVector,
    runPageText: mutations.runPageText,
    runJavaScriptRemoval: mutations.runJavaScriptRemoval,
    runPdfKitMutation: mutations.runPdfKitMutation,
    runPdfKitTargetedMutation: mutations.runPdfKitTargetedMutation,
    runPdfKitTextFieldWidget: mutations.runPdfKitTextFieldWidget,
    runPdfKitLocalGoToMutation: mutations.runPdfKitLocalGoToMutation,
    runPdfKitLocalGoToRemovalMutation: mutations.runPdfKitLocalGoToRemovalMutation,
    runPdfKitOutlineMutation: mutations.runPdfKitOutlineMutation,
    runPdfKitOutlineRemovalMutation: mutations.runPdfKitOutlineRemovalMutation,
    runPdfKitOutlineRenameMutation: mutations.runPdfKitOutlineRenameMutation,
    runPdfKitLineAnnotationMutation: mutations.runPdfKitLineAnnotationMutation,
    runPdfKitInkAnnotationMutation: mutations.runPdfKitInkAnnotationMutation,
    runPdfKitProtection: protection.runPdfKitProtection,
    runPdfKitProtectionRemoval: protection.runPdfKitProtectionRemoval,
    runPdfKitMetadataSanitization: mutations.runPdfKitMetadataSanitization,
    exportPdfKitInspection: inspection.exportPdfKitInspection,
    syncLayerInspection: layers.syncLayerInspection,
    setLayerVisibility: layers.setLayerVisibility,
    resetLayerVisibility: layers.resetLayerVisibility,
    runLayerDefaults: layers.runLayerDefaults,
  });
}
