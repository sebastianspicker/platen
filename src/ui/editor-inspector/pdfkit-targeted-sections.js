import { escapeHtml } from '../shared.js';

function widgetValueControl(state, context) {
  const { selectedPdfkitWidget, pdfkitFormFillReady } = context;
  if (selectedPdfkitWidget?.controlKind === 'checkbox') {
    return `<label class="field-label" for="pdfkit-button-state">Desired checkbox state</label>
          <select id="pdfkit-button-state" ${pdfkitFormFillReady ? '' : 'disabled'}>
            <option value="on" ${state.pdfkitButtonState === 'off' ? '' : 'selected'}>On</option>
            <option value="off" ${state.pdfkitButtonState === 'off' ? 'selected' : ''}>Off</option>
          </select>`;
  }
  if (selectedPdfkitWidget?.controlKind === 'radio') {
    return '<p class="field-help" role="status">This action selects this exact radio widget. Its private option name and the group’s current selection are not exposed.</p>';
  }
  return `<label class="field-label" for="pdfkit-form-value">New value</label>
          <input id="pdfkit-form-value" maxlength="1024" value="${escapeHtml(state.pdfkitFormValue ?? '')}" ${pdfkitFormFillReady ? '' : 'disabled'} />`;
}

function existingAnnotationSelector(state, annotations, ready) {
  const options = annotations.length
    ? annotations.map((annotation) => `<option value="${annotation.annotationIndex}" ${String(annotation.annotationIndex) === String(state.pdfkitExistingAnnotationIndex) ? 'selected' : ''}>${escapeHtml(annotation.subtype)} · page annotation ${annotation.annotationIndex}</option>`).join('')
    : '<option value="">No supported annotations on this page</option>';
  return `<label class="field-label" for="pdfkit-existing-annotation-index">Inert annotation on selected page</label>
          <select id="pdfkit-existing-annotation-index" ${ready ? '' : 'disabled'}>${options}</select>`;
}

function annotationUpdateControls(state, ready) {
  return `<label class="field-label" for="pdfkit-existing-annotation-contents">Replacement contents</label>
          <textarea id="pdfkit-existing-annotation-contents" maxlength="1024" rows="3" ${ready ? '' : 'disabled'}>${escapeHtml(state.pdfkitExistingAnnotationContents ?? '')}</textarea>
          <div class="numeric-grid" aria-label="Replacement annotation rectangle in PDF points">
            <label>X <input id="pdfkit-existing-annotation-x" type="number" step="0.1" value="${escapeHtml(state.pdfkitExistingAnnotationRect?.x ?? 36)}" ${ready ? '' : 'disabled'} /></label>
            <label>Y <input id="pdfkit-existing-annotation-y" type="number" step="0.1" value="${escapeHtml(state.pdfkitExistingAnnotationRect?.y ?? 36)}" ${ready ? '' : 'disabled'} /></label>
            <label>Width <input id="pdfkit-existing-annotation-width" type="number" min="0.1" step="0.1" value="${escapeHtml(state.pdfkitExistingAnnotationRect?.width ?? 180)}" ${ready ? '' : 'disabled'} /></label>
            <label>Height <input id="pdfkit-existing-annotation-height" type="number" min="0.1" step="0.1" value="${escapeHtml(state.pdfkitExistingAnnotationRect?.height ?? 80)}" ${ready ? '' : 'disabled'} /></label>
          </div>`;
}

function annotationPropertyControls(state, ready, selectedAnnotation) {
  const squareReady = ready && selectedAnnotation?.subtype === 'square';
  return `<label class="field-label" for="pdfkit-existing-annotation-stroke-color">Square border color</label>
          <input id="pdfkit-existing-annotation-stroke-color" type="color" value="${escapeHtml(state.pdfkitExistingAnnotationStrokeColor ?? '#d32f2f')}" ${squareReady ? '' : 'disabled'} />
          <button class="button" data-action="update-pdfkit-annotation-properties" ${squareReady ? '' : 'disabled'}>Create Square border update</button>`;
}

const annotationUpdateHelp = [
  'Contents remain private. Updating may regenerate the target appearance stream. ',
  'The Square border update changes only the selected Square’s bounds and border color after reopen, raw-color, and descriptor-preservation checks. ',
  'Removal is a narrow selective-sanitization subset: after reopen, the selected page/index descriptor occurrence must be omitted and every other ordered reachable annotation descriptor must match. ',
  'Raw annotation identity must be unique across the whole document. ',
  'That PDFKit removal does not claim orphan-byte scrubbing or prior-revision removal. ',
  'Flattening is narrower still: it accepts only the sole annotation in the document, a printed square with one tiny resource-free normal appearance on an unrotated page. ',
  'It promotes that appearance into page content and emits a closed rewrite without the annotation object or prior revisions. ',
  'Unsupported appearance states, resources, actions, popups, widgets, filters, and graphs fail closed. ',
  'Sidecar review annotations are never embedded implicitly.',
].join('');

export function pdfkitTargetedSections(state, context) {
  const {
    pdfkitWidgets,
    selectedPdfkitWidget,
    pdfkitFormFillReady,
    pdfkitExistingAnnotations,
    pdfkitExistingAnnotationReady,
    annotationFlattenReady,
  } = context;
  const selectedAnnotation = pdfkitExistingAnnotations.find((annotation) => (
    String(annotation.annotationIndex) === String(state.pdfkitExistingAnnotationIndex)
  ));
  return `
        <details>
          <summary>Fill a source-bound AcroForm field</summary>
          <label class="field-label" for="pdfkit-widget-index">Text, choice, checkbox, or radio widget on selected page</label>
          <select id="pdfkit-widget-index" ${pdfkitFormFillReady ? '' : 'disabled'}>
            ${pdfkitWidgets.length ? pdfkitWidgets.map((widget) => `<option value="${widget.annotationIndex}" ${String(widget.annotationIndex) === String(state.pdfkitWidgetIndex) ? 'selected' : ''}>${escapeHtml(widget.fieldName || 'Unnamed field')} · ${escapeHtml(widget.fieldType === 'button' ? widget.controlKind : widget.fieldType)} · page annotation ${widget.annotationIndex}</option>`).join('') : '<option value="">No supported widgets on this page</option>'}
          </select>
          ${widgetValueControl(state, context)}
          <button class="button primary" data-action="fill-pdfkit-form-field" ${pdfkitFormFillReady ? '' : 'disabled'}>${selectedPdfkitWidget?.controlKind === 'radio' ? 'Select radio option in derived PDF' : 'Create filled PDF'}</button>
          <p class="field-help">Current values, choice options, button export/on-state names, and appearances are never exposed by inspection. For a choice field, enter an exact local label or export value; leaving it empty clears only a non-required, single-selection field after private current-value and render verification. For a checkbox, choose only on or off and the native helper privately resolves and verifies its custom appearance state. For a radio widget, selection is allowed only when the helper proves a canonical 2–50 option parent-and-kids group, consistent private state, unique appearances, and a changed affected-page render after reopen. Push controls are not mutable. Read-only, password, signature, action-bearing, calculation-bearing, shared, malformed, and ambiguous fields fail closed.</p>
        </details>
        <details>
          <summary>Update or remove a source-bound annotation</summary>
          ${existingAnnotationSelector(state, pdfkitExistingAnnotations, pdfkitExistingAnnotationReady)}
          ${annotationUpdateControls(state, pdfkitExistingAnnotationReady)}
          ${annotationPropertyControls(state, pdfkitExistingAnnotationReady, selectedAnnotation)}
          <div class="button-row">
            <button class="button primary" data-action="update-pdfkit-annotation" ${pdfkitExistingAnnotationReady ? '' : 'disabled'}>Create updated PDF</button>
            <button class="button danger-button" data-action="remove-pdfkit-annotation" ${pdfkitExistingAnnotationReady ? '' : 'disabled'}>Create verified removal copy</button>
            <button class="button" data-action="flatten-pdfkit-annotation" ${annotationFlattenReady ? '' : 'disabled'}>Create flattened copy</button>
          </div>
          <p class="field-help">${annotationUpdateHelp}</p>
        </details>`;
}
