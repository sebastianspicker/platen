function handleFileChanges(target, controllers) {
  const {
    lifecycle,
    generation,
    domain,
    pageComposition,
    comparison,
    ocr,
  } = controllers;
  if (target.matches('#file-picker') && target.files?.[0]) (controllers.tabs?.openFile ?? lifecycle.openFile)(target.files[0]);
  if (target.matches('#merge-picker') && target.files?.[0]) pageComposition.mergeFile(target.files[0]);
  if (target.matches('#interleave-picker') && target.files?.[0]) {
    pageComposition.runSecondaryComposition(target.files[0], 'interleave');
  }
  if (target.matches('#insert-picker') && target.files?.[0]) {
    pageComposition.runSecondaryComposition(target.files[0], 'insert');
  }
  if (target.matches('#replace-picker') && target.files?.[0]) {
    pageComposition.runSecondaryComposition(target.files[0], 'replace');
  }
  if (target.matches('#copy-page-picker') && target.files?.[0]) {
    pageComposition.runSecondaryComposition(target.files[0], 'copy-page');
  }
  if (target.matches('#scan-append-picker') && target.files?.[0]) {
    pageComposition.appendScannedPage(target.files[0]);
  }
  if (target.matches('#conversion-picker') && target.files?.[0]) {
    generation.convertLocalFile(target.files[0]);
  }
  if (target.matches('#combine-picker') && target.files?.length) {
    generation.combineMixedFiles(target.files);
  }
  if (target.matches('#comparison-picker') && target.files?.[0]) {
    comparison.compareWithFile(target.files[0]);
  }
  if (target.matches('#project-bundle-picker') && target.files?.[0]) {
    domain.importProjectBundle(target.files[0]);
  }
  if (target.matches('#ocr-batch-picker')) ocr.setOcrBatchFiles(target.files);
}

function handleAecChanges(target, state, render) {
  if (target.matches('#aec-calibration-unit')) state.aecCalibrationUnit = target.value;
  if (target.matches('#aec-display-unit')) state.aecDisplayUnit = target.value;
  if (target.matches('#aec-measurement-kind')) {
    state.aecMeasurementKind = target.value;
    state.aecDisplayUnit = target.value === 'area'
      ? 'ft2'
      : target.value === 'count' ? 'count' : 'ft';
    render();
  }
}

function handleOcrChanges(target, state, ocr, render) {
  if (target.matches('#ocr-language')) {
    state.ocrLanguage = target.value;
    state.ocrResult = null;
    state.ocrSuspectReviewStates = [];
    state.ocrLayoutResult = null;
    render();
  }
  if (target.matches('#ocr-cleanup-preset')) {
    state.ocrCleanupPreset = target.value;
    state.ocrResult = null;
    state.ocrSuspectReviewStates = [];
    state.ocrLayoutResult = null;
    render();
  }
  if (target.matches('#ocr-segmentation')) {
    state.ocrSegmentation = target.value;
    state.ocrResult = null;
    state.ocrSuspectReviewStates = [];
    state.ocrLayoutResult = null;
    render();
  }
  if (target.matches('#ocr-detect-tables')) {
    state.ocrDetectTables = target.checked;
    state.ocrLayoutResult = null;
    render();
  }
  if (target.matches('#ocr-zone-select')) {
    state.selectedOcrZoneId = target.value || null;
    ocr.clearOcrLayoutSelection();
    render();
  }
  if (target.matches('#ocr-zone-type')) {
    ocr.updateSelectedOcrZone('type', target.value);
    render();
  }
  if (target.matches('#ocr-result-record')) {
    state.selectedOcrRecordIndex = target.value === '' ? null : Number(target.value);
    state.selectedOcrTableCandidate = null;
    render();
  }
  if (target.matches('#ocr-table-candidate')) {
    state.selectedOcrTableCandidate = target.value === '' ? null : Number(target.value);
    render();
  }
  if (target.matches('.ocr-suspect-review-state')) {
    ocr.setOcrSuspectReviewState(Number(target.dataset.ocrSuspectIndex), target.value);
    render();
  }
}

function handleViewerAndWorkflowChanges(target, state, { viewer, raster }, render) {
  if (target.matches('#copy-source-page')) state.copySourcePage = target.value;
  if (target.matches('#search-case-sensitive')) {
    state.searchCaseSensitive = target.checked;
    viewer.updateSearchResults();
    render();
  }
  if (target.matches('#search-whole-word')) {
    state.searchWholeWord = target.checked;
    viewer.updateSearchResults();
    render();
  }
  if (target.matches('#text-export-format')) state.textExportFormat = target.value;
  if (target.matches('#overlay-placement')) state.overlayPlacement = target.value;
  if (target.matches('#redaction-full-page')) {
    state.redactionFullPage = target.checked;
    render();
  }
  if (target.matches('#redaction-plan-select')) {
    raster.selectRedactionPlan(target.value);
    render();
  }
  if (target.matches('#redaction-mark-select')) {
    raster.selectRedactionMark(target.value);
    render();
  }
  if (target.matches('#comparison-mode')) {
    state.comparisonMode = target.value;
    state.comparisonReport = null;
    state.comparisonFileName = null;
    render();
  }
  if (target.matches('#snapshot-x, #snapshot-y, #snapshot-width, #snapshot-height')) {
    viewer.resetLoupe('The snapshot region changed.');
    render();
  }
}

function handleAcroFormChanges(target, state, controllers, render) {
  const acroform = controllers.acroform;
  if (target.matches('#acroform-text-field-name')) acroform?.updateTextFieldName?.(target.value);
  else if (target.matches('#acroform-text-field-page')) acroform?.updateTextFieldPage?.(target.value);
  else if (target.matches('#acroform-text-field-x, #acroform-text-field-y, #acroform-text-field-width, #acroform-text-field-height')) acroform?.updateTextFieldRect?.(target.id.replace('acroform-text-field-', ''), target.value);
  else if (target.matches('#acroform-checkbox-field-name')) acroform?.updateCheckboxFieldName?.(target.value);
  else if (target.matches('#acroform-checkbox-page')) acroform?.updateCheckboxPage?.(target.value);
  else if (target.matches('#acroform-checkbox-x, #acroform-checkbox-y, #acroform-checkbox-width, #acroform-checkbox-height')) acroform?.updateCheckboxRect?.(target.id.replace('acroform-checkbox-', ''), target.value);
  else if (target.matches('#acroform-radio-group-name')) acroform?.updateRadioGroupName?.(target.value);
  else if (target.matches('#acroform-choice-field-name')) acroform?.updateChoiceFieldName?.(target.value);
  else if (target.matches('#acroform-choice-page')) acroform?.updateChoicePage?.(target.value);
  else if (target.matches('#acroform-choice-x, #acroform-choice-y, #acroform-choice-width, #acroform-choice-height')) acroform?.updateChoiceRect?.(target.id.replace('acroform-choice-', ''), target.value);
  else if (target.matches('[data-acroform-choice-field]')) acroform?.updateChoiceOption?.(Number(target.dataset.acroformChoiceIndex), target.value);
  else if (target.matches('#bates-pages, #bates-start, #bates-prefix, #bates-suffix, #bates-padding, #bates-position, #bates-margin, #bates-font-size')) { const key = { 'bates-pages': 'batesPages', 'bates-start': 'batesStart', 'bates-prefix': 'batesPrefix', 'bates-suffix': 'batesSuffix', 'bates-padding': 'batesPadding', 'bates-position': 'batesPosition', 'bates-margin': 'batesMargin', 'bates-font-size': 'batesFontSize' }[target.id]; if (key) state[key] = target.value; render(); }
  else if (target.matches('[data-acroform-radio-field]')) acroform?.updateRadioOption?.(Number(target.dataset.acroformRadioIndex), target.dataset.acroformRadioField, target.value);
  else return;
  render();
}

function handleReviewChanges(target, state, render) {
  if (target.matches('#accessibility-alt-text-candidate')) {
    state.accessibilityAltTextCandidateLocator = target.value;
    state.accessibilityAltTextProposalResult = null;
    render();
  }
  if (target.matches('#preflight-profile')) {
    state.preflightProfile = target.value;
    state.prepressResult = null;
    render();
  }
  if (target.matches('#imposition-marks')) state.impositionMarks = target.checked;
  if (target.matches('#standards-profile')) {
    state.standardsProfile = target.value;
    state.standardsValidationResult = null;
    render();
  }
}

function handlePdfKitChanges(target, state, controllers, render) {
  if (target.matches('[data-pdfkit-layer-index]')) {
    const index = Number(target.dataset.pdfkitLayerIndex);
    state.pdfkitLayerVisibility = [...(state.pdfkitLayerVisibility ?? [])];
    controllers?.pdfkit?.setLayerVisibility?.(index, target.checked);
    render();
  }
  if (target.matches('#pdfkit-page-box')) {
    state.pdfkitPageBox = target.value;
    const page = state.pdfkitInspectionResult?.pages?.find(
      ({ index }) => index === state.selectedPage,
    );
    const current = page?.boxes?.[target.value];
    if (current) state.pdfkitPageBoxRect = { ...current };
    state.incrementalBleedBoxResult = null;
    state.pdfkitMutationResult = null;
    render();
  }
  if (target.matches('#pdfkit-page-rotation')) {
    state.pdfkitPageRotation = target.value;
    state.pdfkitMutationResult = null;
    render();
  }
  if (target.matches('#pdfkit-annotation-subtype')) state.pdfkitAnnotationSubtype = target.value;
  if (target.matches('#pdfkit-widget-index')) {
    state.pdfkitWidgetIndex = target.value;
    state.pdfkitMutationResult = null;
    render();
  }
  if (target.matches('#pdfkit-button-state')) {
    state.pdfkitButtonState = target.value;
    state.pdfkitMutationResult = null;
  }
  if (target.matches('#pdfkit-link-target-page')) {
    state.pdfkitLinkTargetPage = target.value;
    state.incrementalGoToLinkResult = null;
    state.pdfkitMutationResult = null;
  }
  if (target.matches('#incremental-named-destination-target-page')) {
    state.incrementalNamedDestinationTargetPage = target.value;
    state.incrementalNamedDestinationResult = null;
  }
  if (target.matches('#pdfkit-local-link-removal-index')) {
    state.pdfkitLocalLinkRemovalIndex = target.value;
    state.pdfkitMutationResult = null;
  }
  if (target.matches('#pdfkit-outline-target-page')) {
    state.pdfkitOutlineTargetPage = target.value;
    state.pdfkitMutationResult = null;
  }
  if (target.matches('#pdfkit-outline-removal-index')) {
    state.pdfkitOutlineRemovalIndex = target.value;
    state.pdfkitMutationResult = null;
  }
  if (target.matches('#pdfkit-outline-rename-index')) {
    state.pdfkitOutlineRenameIndex = target.value;
    state.pdfkitMutationResult = null;
  }
  if (target.matches('#pdfkit-existing-annotation-index')) {
    state.pdfkitExistingAnnotationIndex = target.value;
    state.annotationFlattenResult = null;
  }
  if (target.matches('#pdfkit-box-x, #pdfkit-box-y, #pdfkit-box-width, #pdfkit-box-height')) {
    state.incrementalBleedBoxResult = null;
    render();
  }
}

export function createApplicationChangeHandler({ state, controllers, render }) {
  return function handleChange({ target }) {
    handleFileChanges(target, controllers);
    handleAecChanges(target, state, render);
    handleOcrChanges(target, state, controllers.ocr, render);
    handleViewerAndWorkflowChanges(target, state, controllers, render);
    handleAcroFormChanges(target, state, controllers, render);
    handleReviewChanges(target, state, render);
    handlePdfKitChanges(target, state, controllers, render);
  };
}
