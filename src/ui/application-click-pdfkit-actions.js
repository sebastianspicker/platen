function createPdfKitInspectionActions({ controllers: { pdfkit } }) {
  return {
    'run-pdfkit-inspection': pdfkit.runPdfKitInspection,
    'remove-document-attachment': pdfkit.runAttachmentRemoval,
    'export-pdfkit-inspection': pdfkit.exportPdfKitInspection,
    'reset-pdfkit-layers': pdfkit.resetLayerVisibility,
    'apply-pdfkit-layers': pdfkit.runLayerDefaults,
    'create-incremental-bleed-box-copy': pdfkit.runIncrementalBleedBox,
    'create-incremental-goto-link-copy': pdfkit.runIncrementalGoToLink,
    'create-incremental-named-destination-copy': pdfkit.runIncrementalNamedDestination,
    'create-incremental-metadata-copy': pdfkit.runIncrementalMetadata,
    'create-incremental-page-vector-copy': pdfkit.runIncrementalPageVector,
    'create-page-text-copy': pdfkit.runPageText,
    'remove-document-javascript': pdfkit.runJavaScriptRemoval,
    'create-pdfkit-metadata-copy': () => pdfkit.runPdfKitMutation('metadata'),
    'create-pdfkit-pagebox-copy': () => pdfkit.runPdfKitMutation('page-box'),
    'create-pdfkit-rotation-copy': () => pdfkit.runPdfKitMutation('rotation'),
    'create-pdfkit-annotation-copy': () => pdfkit.runPdfKitMutation('annotation'),
  };
}

function createAcroFormActions({ controllers: { acroform = {} } }) {
  return {
    'create-acroform-checkbox': acroform.runCheckbox,
    'create-acroform-radio': acroform.runRadio,
    'create-acroform-text-field': acroform.runTextField,
    'create-acroform-choice': acroform.runChoice,
    'add-acroform-radio-option': acroform.addRadioOption,
    'remove-acroform-radio-option': (element) => acroform.removeRadioOption(Number(element.dataset.acroformRadioIndex)),
    'add-acroform-choice-option': acroform.addChoiceOption,
    'remove-acroform-choice-option': (element) => acroform.removeChoiceOption(Number(element.dataset.acroformChoiceIndex)),
  };
}

function createPdfKitAnnotationActions({ controllers: { pdfkit } }) {
  return {
    'create-pdfkit-local-goto-copy': pdfkit.runPdfKitLocalGoToMutation,
    'remove-pdfkit-local-goto-link': pdfkit.runPdfKitLocalGoToRemovalMutation,
    'create-pdfkit-outline-copy': pdfkit.runPdfKitOutlineMutation,
    'remove-pdfkit-outline-bookmark': pdfkit.runPdfKitOutlineRemovalMutation,
    'rename-pdfkit-outline-bookmark': pdfkit.runPdfKitOutlineRenameMutation,
    'create-pdfkit-line-annotation-copy': pdfkit.runPdfKitLineAnnotationMutation,
    'create-pdfkit-ink-annotation-copy': pdfkit.runPdfKitInkAnnotationMutation,
    'fill-pdfkit-form-field': () => pdfkit.runPdfKitTargetedMutation('form-fill'),
    'create-pdfkit-text-field-widget': pdfkit.runPdfKitTextFieldWidget,
    'update-pdfkit-annotation': () => pdfkit.runPdfKitTargetedMutation('annotation-update'),
    'update-pdfkit-annotation-properties': () => pdfkit.runPdfKitTargetedMutation('annotation-properties'),
    'remove-pdfkit-annotation': () => pdfkit.runPdfKitTargetedMutation('annotation-remove'),
    'flatten-pdfkit-annotation': pdfkit.runAnnotationFlatten,
  };
}

function createPdfKitProtectionActions({ controllers: { pdfkit } }) {
  return {
    'create-pdfkit-protected-copy': pdfkit.runPdfKitProtection,
    'remove-pdfkit-protection': pdfkit.runPdfKitProtectionRemoval,
    'sanitize-pdfkit-metadata': pdfkit.runPdfKitMetadataSanitization,
  };
}

export function createApplicationPdfKitActions(context) {
  return {
    ...createAcroFormActions(context),
    ...createPdfKitInspectionActions(context),
    ...createPdfKitAnnotationActions(context),
    ...createPdfKitProtectionActions(context),
  };
}
