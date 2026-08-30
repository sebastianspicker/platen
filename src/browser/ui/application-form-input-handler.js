const DIRECT_BINDINGS = Object.freeze({
  '#domain-payload': 'domainPayload',
  '#new-document-title': 'creationTitle',
  '#new-document-text': 'creationText',
  '#blank-page-count': 'blankPageCount',
  '#split-rule-pages': 'splitRulePages',
  '#snapshot-dpi': 'snapshotDpi',
  '#aec-calibration-points': 'aecCalibrationPoints',
  '#aec-real-length': 'aecRealLength',
  '#aec-measurement-points': 'aecMeasurementPoints',
  '#aec-measurement-label': 'aecMeasurementLabel',
  '#overlay-text': 'overlayText',
  '#redaction-text': 'redactionText',
  '#resize-width': 'resizeWidth',
  '#resize-height': 'resizeHeight',
});

const ACCESSIBILITY_METADATA_BINDINGS = Object.freeze({
  '#accessibility-document-language': 'accessibilityDocumentLanguage',
  '#accessibility-document-title': 'accessibilityDocumentTitle',
  '#accessibility-alt-text': 'accessibilityAltText',
});

const METADATA_BINDINGS = Object.freeze({
  '#pdfkit-title': 'title',
  '#pdfkit-author': 'author',
  '#pdfkit-subject': 'subject',
  '#pdfkit-keywords': 'keywords',
});

const PDFKIT_TEXT_BINDINGS = Object.freeze({
  '#pdfkit-annotation-contents': 'pdfkitAnnotationContents',
  '#pdfkit-line-contents': 'pdfkitLineContents',
  '#pdfkit-ink-contents': 'pdfkitInkContents',
  '#pdfkit-ink-points': 'pdfkitInkPoints',
  '#pdfkit-form-value': 'pdfkitFormValue',
  '#pdfkit-existing-annotation-contents': 'pdfkitExistingAnnotationContents',
  '#pdfkit-existing-annotation-stroke-color': 'pdfkitExistingAnnotationStrokeColor',
  '#pdfkit-outline-label': 'pdfkitOutlineLabel',
  '#pdfkit-outline-rename-label': 'pdfkitOutlineRenameLabel',
  '#incremental-named-destination-name': 'incrementalNamedDestinationName',
  '#pdfkit-text-field-name': 'pdfkitTextFieldName',
  '#pdfkit-text-field-default': 'pdfkitTextFieldDefaultValue',
});

function applyBinding(target, state, bindings) {
  for (const [selector, key] of Object.entries(bindings)) {
    if (target.matches(selector)) {
      state[key] = target.value;
      return true;
    }
  }
  return false;
}

function applyAccessibilityMetadataBinding(target, state, documentApi, render) {
  for (const [selector, key] of Object.entries(ACCESSIBILITY_METADATA_BINDINGS)) {
    if (!target.matches(selector)) continue;
    state[key] = target.value;
    if (key === 'accessibilityAltText') state.accessibilityAltTextProposalResult = null;
    else state.incrementalAccessibilityMetadataResult = null;
    const { selectionStart } = target;
    render();
    restoreInputFocus(documentApi, selector, selectionStart);
    return true;
  }
  return false;
}

function applyMetadataBinding(target, state) {
  for (const [selector, key] of Object.entries(METADATA_BINDINGS)) {
    if (target.matches(selector)) {
      state.pdfkitMetadata[key] = target.value;
      state.incrementalMetadataResult = null;
      state.pdfkitMutationResult = null;
      return true;
    }
  }
  return false;
}

function numericBindings(state) {
  return {
    '#crop-x': [state.cropRegion, 'x'],
    '#crop-y': [state.cropRegion, 'y'],
    '#crop-width': [state.cropRegion, 'width'],
    '#crop-height': [state.cropRegion, 'height'],
    '#redact-x': [state.redactionRegion, 'x'],
    '#redact-y': [state.redactionRegion, 'y'],
    '#redact-width': [state.redactionRegion, 'width'],
    '#redact-height': [state.redactionRegion, 'height'],
    '#snapshot-x': [state.snapshotRegion, 'x'],
    '#snapshot-y': [state.snapshotRegion, 'y'],
    '#snapshot-width': [state.snapshotRegion, 'width'],
    '#snapshot-height': [state.snapshotRegion, 'height'],
    '#pdfkit-box-x': [state.pdfkitPageBoxRect, 'x'],
    '#pdfkit-box-y': [state.pdfkitPageBoxRect, 'y'],
    '#pdfkit-box-width': [state.pdfkitPageBoxRect, 'width'],
    '#pdfkit-box-height': [state.pdfkitPageBoxRect, 'height'],
    '#pdfkit-annotation-x': [state.pdfkitAnnotationRect, 'x'],
    '#pdfkit-annotation-y': [state.pdfkitAnnotationRect, 'y'],
    '#pdfkit-annotation-width': [state.pdfkitAnnotationRect, 'width'],
    '#pdfkit-annotation-height': [state.pdfkitAnnotationRect, 'height'],
    '#pdfkit-link-x': [state.pdfkitLinkRect, 'x'],
    '#pdfkit-link-y': [state.pdfkitLinkRect, 'y'],
    '#pdfkit-link-width': [state.pdfkitLinkRect, 'width'],
    '#pdfkit-link-height': [state.pdfkitLinkRect, 'height'],
    '#incremental-page-vector-x': [state.incrementalPageVectorRect, 'x'],
    '#incremental-page-vector-y': [state.incrementalPageVectorRect, 'y'],
    '#incremental-page-vector-width': [state.incrementalPageVectorRect, 'width'],
    '#incremental-page-vector-height': [state.incrementalPageVectorRect, 'height'],
    '#page-text-x': [state.pageTextRun, 'x'],
    '#page-text-y': [state.pageTextRun, 'y'],
    '#page-text-size': [state.pageTextRun, 'size'],
    '#pdfkit-line-start-x': [state.pdfkitLineStart, 'x'],
    '#pdfkit-line-start-y': [state.pdfkitLineStart, 'y'],
    '#pdfkit-line-end-x': [state.pdfkitLineEnd, 'x'],
    '#pdfkit-line-end-y': [state.pdfkitLineEnd, 'y'],
    '#pdfkit-existing-annotation-x': [state.pdfkitExistingAnnotationRect, 'x'],
    '#pdfkit-existing-annotation-y': [state.pdfkitExistingAnnotationRect, 'y'],
    '#pdfkit-existing-annotation-width': [state.pdfkitExistingAnnotationRect, 'width'],
    '#pdfkit-existing-annotation-height': [state.pdfkitExistingAnnotationRect, 'height'],
    '#pdfkit-text-field-x': [state.pdfkitTextFieldRect, 'x'],
    '#pdfkit-text-field-y': [state.pdfkitTextFieldRect, 'y'],
    '#pdfkit-text-field-width': [state.pdfkitTextFieldRect, 'width'],
    '#pdfkit-text-field-height': [state.pdfkitTextFieldRect, 'height'],
  };
}

function applyNumericBinding(target, state) {
  for (const [selector, [bindingTarget, key]] of Object.entries(numericBindings(state))) {
    if (target.matches(selector)) {
      bindingTarget[key] = target.value;
      if (selector.startsWith('#pdfkit-')) {
        state.incrementalBleedBoxResult = null;
        if (selector.startsWith('#pdfkit-link-')) state.incrementalGoToLinkResult = null;
        state.pdfkitMutationResult = null;
      }
      if (selector.startsWith('#incremental-page-vector-')) {
        state.incrementalPageVectorResult = null;
      }
      if (selector.startsWith('#page-text-')) state.pageTextResult = null;
      return true;
    }
  }
  return false;
}

function restoreInputFocus(documentApi, selector, selectionStart) {
  const nextInput = documentApi.querySelector(selector);
  nextInput?.focus();
  nextInput?.setSelectionRange(selectionStart, selectionStart);
}

function applySearchInput(target, state, viewer, documentApi, render) {
  if (target.matches('#plugin-search')) {
    state.pluginQuery = target.value;
    const { selectionStart } = target;
    render();
    restoreInputFocus(documentApi, '#plugin-search', selectionStart);
    return true;
  }
  if (target.matches('#document-search')) {
    state.searchQuery = target.value;
    viewer.updateSearchResults();
    const { selectionStart } = target;
    render();
    restoreInputFocus(documentApi, '#document-search', selectionStart);
    return true;
  }
  return false;
}

function applyAcroFormInput(target, state) {
  if (state.busyAction) return false;
  if (target.matches('#acroform-text-field-name')) state.acroFormTextFieldName = target.value;
  else if (target.matches('#acroform-text-field-page')) state.acroFormTextFieldPage = target.value;
  else if (target.matches('#acroform-text-field-x, #acroform-text-field-y, #acroform-text-field-width, #acroform-text-field-height')) state.acroFormTextFieldRect[target.id.replace('acroform-text-field-', '')] = target.value;
  else if (target.matches('#acroform-checkbox-field-name')) state.acroFormCheckboxFieldName = target.value;
  else if (target.matches('#acroform-checkbox-page')) state.acroFormCheckboxPage = target.value;
  else if (target.matches('#acroform-checkbox-x, #acroform-checkbox-y, #acroform-checkbox-width, #acroform-checkbox-height')) {
    state.acroFormCheckboxRect[target.id.replace('acroform-checkbox-', '')] = target.value;
  } else if (target.matches('#acroform-radio-group-name')) state.acroFormRadioGroupName = target.value;
  else if (target.matches('#acroform-choice-field-name')) state.acroFormChoiceFieldName = target.value;
  else if (target.matches('#acroform-choice-page')) state.acroFormChoicePage = target.value;
  else if (target.matches('#acroform-choice-x, #acroform-choice-y, #acroform-choice-width, #acroform-choice-height')) state.acroFormChoiceRect[target.id.replace('acroform-choice-', '')] = target.value;
  else if (target.matches('[data-acroform-choice-field]')) state.acroFormChoiceOptions[Number(target.dataset.acroformChoiceIndex)].label = target.value;
  else if (target.matches('#bates-pages, #bates-start, #bates-prefix, #bates-suffix, #bates-padding, #bates-position, #bates-margin, #bates-font-size')) state[{ '#bates-pages': 'batesPages', '#bates-start': 'batesStart', '#bates-prefix': 'batesPrefix', '#bates-suffix': 'batesSuffix', '#bates-padding': 'batesPadding', '#bates-position': 'batesPosition', '#bates-margin': 'batesMargin', '#bates-font-size': 'batesFontSize' }[target.id]] = target.value;
  else if (target.matches('[data-acroform-radio-field]')) {
    const index = Number(target.dataset.acroformRadioIndex);
    const key = target.dataset.acroformRadioField;
    const entry = state.acroFormRadioOptions?.[index];
    if (!entry) return false;
    if (key === 'label' || key === 'page') entry[key] = target.value;
    else if (key === 'x') entry.rect.x = target.value;
    else if (key === 'y') entry.rect.y = target.value;
    else if (key === 'width') entry.rect.width = target.value;
    else if (key === 'height') entry.rect.height = target.value;
    else return false;
  } else return false;
  state.acroFormStatus = 'idle';
  state.acroFormError = null;
  state.acroFormResult = null;
  return true;
}

export function createApplicationInputHandler({ state, ocr, viewer, documentApi, render }) {
  return function handleInput({ target }) {
    if (applyAcroFormInput(target, state)) return;
    if (applyBinding(target, state, DIRECT_BINDINGS)) return;
    if (applyAccessibilityMetadataBinding(target, state, documentApi, render)) return;
    if (target.matches('#prepress-dpi')) {
      state.prepressDpi = target.value;
      state.prepressResult = null;
      return;
    }
    if (applyMetadataBinding(target, state)) return;
    if (target.matches('#page-text-value')) {
      state.pageTextRun.text = target.value;
      state.pageTextResult = null;
      return;
    }
    if (applyBinding(target, state, PDFKIT_TEXT_BINDINGS)) {
      if (target.matches('#incremental-named-destination-name')) {
        state.incrementalNamedDestinationResult = null;
      }
      state.pdfkitMutationResult = null;
      return;
    }
    if (target.matches('#ocr-zone-x, #ocr-zone-y, #ocr-zone-width, #ocr-zone-height')) {
      ocr.updateSelectedOcrZone(target.id.replace('ocr-zone-', ''), target.value);
      return;
    }
    if (target.matches('#ocr-user-dictionary')) {
      state.ocrUserDictionary = target.value;
      state.ocrResult = null;
      state.ocrSuspectReviewStates = [];
      return;
    }
    if (applyNumericBinding(target, state)) return;
    applySearchInput(target, state, viewer, documentApi, render);
  };
}
