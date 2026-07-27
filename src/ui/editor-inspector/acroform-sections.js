import { escapeHtml } from '../shared.js';

function numberInput(id, label, value, disabled, attrs = '') {
  return `<label class="field-label" for="${id}">${label}</label><input id="${id}" type="number" step="any" value="${escapeHtml(value ?? '')}" ${attrs} ${disabled ? 'disabled' : ''} />`;
}

function status(state) {
  if (state.acroFormStatus === 'loading') return '<p class="field-help" role="status">Creating and validating a separate AcroForm PDF…</p>';
  if (state.acroFormStatus === 'cancelled') return '<p class="field-help" role="status">AcroForm authoring cancelled. The source PDF is unchanged.</p>';
  if (state.acroFormStatus === 'error' && state.acroFormError) return `<p class="field-help error-text" role="alert">${escapeHtml(state.acroFormError)}</p>`;
  if (state.acroFormStatus === 'success') return `<p class="field-help" role="status">${escapeHtml(state.acroFormResult?.artifact?.displayName ?? 'Derived PDF')} downloaded. The immutable source is unchanged.</p>`;
  return '';
}

export function acroFormSections(state) {
  const analysis = state.analysis ?? {};
  const signatures = analysis.signatures;
  const unsigned = signatures?.status === 'unsigned' && (signatures.signatureCount ?? signatures.count) === 0;
  const documentReady = analysis.status === 'ready' && typeof analysis.documentId === 'string' && /^[a-f0-9]{64}$/u.test(analysis.sha256 ?? '') && unsigned;
  const checkboxReady = documentReady && state.host?.acroFormCheckboxReady === true && !state.busyAction;
  const radioReady = documentReady && state.host?.acroFormRadioReady === true && !state.busyAction;
  const textFieldReady = documentReady && state.host?.acroFormTextFieldReady === true && !state.busyAction;
  const choiceReady = documentReady && state.host?.acroFormChoiceReady === true && !state.busyAction;
  const choiceOptions = Array.isArray(state.acroFormChoiceOptions) ? state.acroFormChoiceOptions : [];
  const options = Array.isArray(state.acroFormRadioOptions) ? state.acroFormRadioOptions : [];
  let explanation = 'Authoring is available only for an unsigned current PDF and a ready local host.';
  if (analysis.status === 'ready' && !unsigned) explanation = 'This PDF has signature evidence; form authoring is disabled to avoid implying signature preservation.';
  else if (analysis.status === 'ready' && unsigned && state.host?.acroFormCheckboxReady !== true && state.host?.acroFormRadioReady !== true && state.host?.acroFormTextFieldReady !== true) explanation = 'The local passive AcroForm authoring services are unavailable.';
  return `<section class="property-section acroform-section" aria-labelledby="acroform-heading">
    <h3 id="acroform-heading">Create form controls</h3>
    <p class="field-help">${escapeHtml(explanation)} Each action creates and downloads a separate PDF bound to the current document ID and SHA-256. The strict passive profiles create unchecked controls only and reject existing forms/widgets, signed or encrypted files, tags, layers, actions, JavaScript, calculations, XFA, and unsupported structures. The host remains the final authority; no signature-preservation claim is made.</p>
    <div class="nested-control-group" role="group" aria-labelledby="acroform-text-field-heading">
      <h4 id="acroform-text-field-heading">Passive text field</h4>
      <p class="field-help">Strict classic-PDF profile: one empty terminal field with Helvetica <code>/DR</code> and <code>/DA</code> evidence. This is separate from the native PDFKit text-field widget path.</p>
      <label class="field-label" for="acroform-text-field-name">Field name</label>
      <input id="acroform-text-field-name" type="text" maxlength="127" value="${escapeHtml(state.acroFormTextFieldName ?? '')}" ${textFieldReady ? '' : 'disabled'} />
      ${numberInput('acroform-text-field-page', 'Page', state.acroFormTextFieldPage, !textFieldReady, 'min="1" max="10000"')}
      <div class="inline-fields">
        ${numberInput('acroform-text-field-x', 'X', state.acroFormTextFieldRect?.x, !textFieldReady)}
        ${numberInput('acroform-text-field-y', 'Y', state.acroFormTextFieldRect?.y, !textFieldReady)}
        ${numberInput('acroform-text-field-width', 'Width', state.acroFormTextFieldRect?.width, !textFieldReady, 'min="0.000001"')}
        ${numberInput('acroform-text-field-height', 'Height', state.acroFormTextFieldRect?.height, !textFieldReady, 'min="0.000001"')}
      </div>
      <button class="button primary" data-action="create-acroform-text-field" ${textFieldReady ? '' : 'disabled'}>Create passive text-field PDF</button>
    </div>
    <div class="nested-control-group" role="group" aria-labelledby="acroform-checkbox-heading">
      <h4 id="acroform-checkbox-heading">Checkbox</h4>
      <label class="field-label" for="acroform-checkbox-field-name">Field name</label>
      <input id="acroform-checkbox-field-name" type="text" maxlength="127" value="${escapeHtml(state.acroFormCheckboxFieldName ?? '')}" ${checkboxReady ? '' : 'disabled'} />
      ${numberInput('acroform-checkbox-page', 'Page', state.acroFormCheckboxPage, !checkboxReady, 'min="1" max="10000"')}
      <div class="inline-fields">
        ${numberInput('acroform-checkbox-x', 'X', state.acroFormCheckboxRect?.x, !checkboxReady)}
        ${numberInput('acroform-checkbox-y', 'Y', state.acroFormCheckboxRect?.y, !checkboxReady)}
        ${numberInput('acroform-checkbox-width', 'Width', state.acroFormCheckboxRect?.width, !checkboxReady, 'min="0.000001"')}
        ${numberInput('acroform-checkbox-height', 'Height', state.acroFormCheckboxRect?.height, !checkboxReady, 'min="0.000001"')}
      </div>
      <button class="button primary" data-action="create-acroform-checkbox" ${checkboxReady ? '' : 'disabled'}>Create checkbox PDF</button>
    </div>
    <div class="nested-control-group" role="group" aria-labelledby="acroform-radio-heading">
      <h4 id="acroform-radio-heading">Radio group</h4>
      <label class="field-label" for="acroform-radio-group-name">Group name</label>
      <input id="acroform-radio-group-name" type="text" maxlength="127" value="${escapeHtml(state.acroFormRadioGroupName ?? '')}" ${radioReady ? '' : 'disabled'} />
      <div class="acroform-radio-options" role="group" aria-label="Radio group options">
        ${options.map((option, index) => `<div class="nested-control-group acroform-radio-option" data-acroform-radio-index="${index}">
          <h5>Option ${index + 1}</h5>
          <label class="field-label" for="acroform-radio-${index}-label">Label</label><input id="acroform-radio-${index}-label" type="text" maxlength="127" value="${escapeHtml(option?.label ?? '')}" data-acroform-radio-field="label" data-acroform-radio-index="${index}" ${radioReady ? '' : 'disabled'} />
          ${numberInput(`acroform-radio-${index}-page`, 'Page', option?.page, !radioReady, `min="1" max="10000" data-acroform-radio-field="page" data-acroform-radio-index="${index}"`)}
          <div class="inline-fields">
            ${numberInput(`acroform-radio-${index}-x`, 'X', option?.rect?.x, !radioReady, `data-acroform-radio-field="x" data-acroform-radio-index="${index}"`)}
            ${numberInput(`acroform-radio-${index}-y`, 'Y', option?.rect?.y, !radioReady, `data-acroform-radio-field="y" data-acroform-radio-index="${index}"`)}
            ${numberInput(`acroform-radio-${index}-width`, 'Width', option?.rect?.width, !radioReady, `min="0.000001" data-acroform-radio-field="width" data-acroform-radio-index="${index}"`)}
            ${numberInput(`acroform-radio-${index}-height`, 'Height', option?.rect?.height, !radioReady, `min="0.000001" data-acroform-radio-field="height" data-acroform-radio-index="${index}"`)}
          </div>
          <button class="button" data-action="remove-acroform-radio-option" data-acroform-radio-index="${index}" ${radioReady && options.length > 2 ? '' : 'disabled'}>Remove option ${index + 1}</button>
        </div>`).join('')}
      </div>
      <button class="button" data-action="add-acroform-radio-option" ${radioReady && options.length < 10 ? '' : 'disabled'}>Add radio option</button>
      <button class="button primary" data-action="create-acroform-radio" ${radioReady ? '' : 'disabled'}>Create radio-group PDF</button>
    </div>
    <div class="nested-control-group" role="group" aria-labelledby="acroform-choice-heading">
      <h4 id="acroform-choice-heading">Non-combo list/choice field</h4>
      <p class="field-help">Creates an unchecked non-combo list/choice field with no default selection and two through fifty unique options.</p>
      <label class="field-label" for="acroform-choice-field-name">Field name</label><input id="acroform-choice-field-name" type="text" maxlength="127" value="${escapeHtml(state.acroFormChoiceFieldName ?? '')}" ${choiceReady ? '' : 'disabled'} />
      ${numberInput('acroform-choice-page', 'Page', state.acroFormChoicePage, !choiceReady, 'min="1" max="10000"')}
      <div class="inline-fields">${numberInput('acroform-choice-x', 'X', state.acroFormChoiceRect?.x, !choiceReady)}${numberInput('acroform-choice-y', 'Y', state.acroFormChoiceRect?.y, !choiceReady)}${numberInput('acroform-choice-width', 'Width', state.acroFormChoiceRect?.width, !choiceReady, 'min="0.000001"')}${numberInput('acroform-choice-height', 'Height', state.acroFormChoiceRect?.height, !choiceReady, 'min="0.000001"')}</div>
      <div class="acroform-choice-options" role="group" aria-label="List choice options">${choiceOptions.map((option, index) => `<div class="inline-fields"><label class="field-label" for="acroform-choice-${index}-label">Option ${index + 1}</label><input id="acroform-choice-${index}-label" type="text" maxlength="127" value="${escapeHtml(option?.label ?? '')}" data-acroform-choice-field="label" data-acroform-choice-index="${index}" ${choiceReady ? '' : 'disabled'} /><button class="button" data-action="remove-acroform-choice-option" data-acroform-choice-index="${index}" ${choiceReady && choiceOptions.length > 2 ? '' : 'disabled'}>Remove</button></div>`).join('')}</div>
      <button class="button" data-action="add-acroform-choice-option" ${choiceReady && choiceOptions.length < 50 ? '' : 'disabled'}>Add option</button>
      <button class="button primary" data-action="create-acroform-choice" ${choiceReady ? '' : 'disabled'}>Create non-combo list/choice PDF</button>
    </div>
    ${status(state)}
  </section>`;
}
