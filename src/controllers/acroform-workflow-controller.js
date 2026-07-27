const CHECKBOX_PROFILE = 'local-pdf-acroform-checkbox-v1';
const RADIO_PROFILE = 'local-pdf-acroform-radio-v1';
const TEXT_FIELD_PROFILE = 'local-pdf-acroform-text-field-v1';
const MAX_PAGE = 10_000;
const MAX_COORDINATE = 1_000_000;

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_ACROFORM_UI_OPTIONS';
  return error;
}

function boundedText(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value !== value.normalize('NFC')
    || [...value].length > 127 || new TextEncoder().encode(value).length > 512
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value)) {
    throw invalid(`${label} must be bounded NFC text.`);
  }
  return value;
}

function boundedPage(value, label, pageCount) {
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE || page > pageCount) {
    throw invalid(`${label} must select a page in the open PDF.`);
  }
  return page;
}

function boundedRect(value, label) {
  const rect = Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number(value?.[key])]));
  if (Object.values(rect).some((entry) => !Number.isFinite(entry) || Math.abs(entry) > MAX_COORDINATE)
    || rect.width <= 0 || rect.height <= 0) throw invalid(`${label} must be a positive bounded rectangle.`);
  return Object.freeze(rect);
}

function unsignedCurrent(state) {
  const signatures = state.analysis?.signatures;
  return state.analysis?.status === 'ready' && typeof state.analysis?.documentId === 'string'
    && /^[a-f0-9]{64}$/u.test(state.analysis?.sha256 ?? '')
    && signatures?.status === 'unsigned'
    && (signatures.signatureCount ?? signatures.count) === 0;
}

function snapshotCheckbox(state) {
  const pageCount = Number(state.analysis?.inspection?.pageCount);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw invalid('The open PDF page count is unavailable.');
  return Object.freeze({
    profile: CHECKBOX_PROFILE,
    sourceSha256: state.analysis.sha256,
    page: boundedPage(state.acroFormCheckboxPage, 'Checkbox page', pageCount),
    fieldName: boundedText(state.acroFormCheckboxFieldName, 'Checkbox field name'),
    rect: boundedRect(state.acroFormCheckboxRect, 'Checkbox rectangle'),
  });
}

function snapshotRadio(state) {
  const pageCount = Number(state.analysis?.inspection?.pageCount);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw invalid('The open PDF page count is unavailable.');
  const groupName = boundedText(state.acroFormRadioGroupName, 'Radio group name');
  const source = Array.isArray(state.acroFormRadioOptions) ? state.acroFormRadioOptions : [];
  if (source.length < 2 || source.length > 10) throw invalid('A radio group requires two through ten options.');
  const labels = new Set(); const locations = new Set();
  const options = source.map((entry, index) => {
    const label = boundedText(entry?.label, `Radio option ${index + 1} label`);
    if (labels.has(label)) throw invalid('Radio option labels must be unique.');
    labels.add(label);
    const page = boundedPage(entry?.page, `Radio option ${index + 1} page`, pageCount);
    const rect = boundedRect(entry?.rect, `Radio option ${index + 1} rectangle`);
    const location = `${page}\u0000${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (locations.has(location)) throw invalid('Radio option page and rectangles must be unique.');
    locations.add(location);
    return Object.freeze({ label, page, rect });
  });
  return Object.freeze({ profile: RADIO_PROFILE, sourceSha256: state.analysis.sha256, groupName, options: Object.freeze(options) });
}
function snapshotTextField(state) {
  const pageCount = Number(state.analysis?.inspection?.pageCount);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw invalid('The open PDF page count is unavailable.');
  return Object.freeze({ profile: TEXT_FIELD_PROFILE, sourceSha256: state.analysis.sha256, page: boundedPage(state.acroFormTextFieldPage, 'Text-field page', pageCount), fieldName: boundedText(state.acroFormTextFieldName, 'Text-field name'), rect: boundedRect(state.acroFormTextFieldRect, 'Text-field rectangle') });
}
function snapshotChoice(state) {
  const pageCount = Number(state.analysis?.inspection?.pageCount); if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw invalid('The open PDF page count is unavailable.');
  const options = Array.isArray(state.acroFormChoiceOptions) ? state.acroFormChoiceOptions : []; const labels = new Set(); if (options.length < 2 || options.length > 50) throw invalid('A list field requires two through fifty options.');
  return Object.freeze({ profile: 'local-pdf-acroform-choice-v1', sourceSha256: state.analysis.sha256, page: boundedPage(state.acroFormChoicePage, 'Choice field page', pageCount), fieldName: boundedText(state.acroFormChoiceFieldName, 'Choice field name'), rect: boundedRect(state.acroFormChoiceRect, 'Choice field rectangle'), options: Object.freeze(options.map((entry, index) => { const label = boundedText(entry?.label, `Choice option ${index + 1} label`); if (labels.has(label)) throw invalid('Choice option labels must be unique.'); labels.add(label); return Object.freeze({ label }); })) });
}

export function createAcroFormWorkflowController({
  state, client, captureOperation, operationIsCurrent, reportOperationError,
  finishOperation, render, announce, downloadDerivedArtifact,
}) {
  function canRun(kind) {
    const readiness = kind === 'checkbox' ? 'acroFormCheckboxReady' : kind === 'radio' ? 'acroFormRadioReady' : kind === 'choice' ? 'acroFormChoiceReady' : 'acroFormTextFieldReady';
    return unsignedCurrent(state) && !state.busyAction && state.host?.[readiness] === true;
  }

  function clearOutcome() {
    state.acroFormStatus = 'idle';
    state.acroFormError = null;
    state.acroFormResult = null;
  }

  function updateCheckboxFieldName(value) { if (state.busyAction) return; state.acroFormCheckboxFieldName = value; clearOutcome(); render(); }
  function updateCheckboxPage(value) { if (state.busyAction) return; state.acroFormCheckboxPage = value; clearOutcome(); render(); }
  function updateCheckboxRect(key, value) { if (state.busyAction) return; state.acroFormCheckboxRect = { ...state.acroFormCheckboxRect, [key]: value }; clearOutcome(); render(); }
  function updateTextFieldName(value) { if (state.busyAction) return; state.acroFormTextFieldName = value; clearOutcome(); render(); }
  function updateTextFieldPage(value) { if (state.busyAction) return; state.acroFormTextFieldPage = value; clearOutcome(); render(); }
  function updateTextFieldRect(key, value) { if (state.busyAction) return; state.acroFormTextFieldRect = { ...state.acroFormTextFieldRect, [key]: value }; clearOutcome(); render(); }
  function updateChoiceFieldName(value) { if (state.busyAction) return; state.acroFormChoiceFieldName = value; clearOutcome(); render(); }
  function updateChoicePage(value) { if (state.busyAction) return; state.acroFormChoicePage = value; clearOutcome(); render(); }
  function updateChoiceRect(key, value) { if (state.busyAction) return; state.acroFormChoiceRect = { ...state.acroFormChoiceRect, [key]: value }; clearOutcome(); render(); }
  function updateChoiceOption(index, value) { if (state.busyAction || !state.acroFormChoiceOptions?.[index]) return; state.acroFormChoiceOptions = state.acroFormChoiceOptions.map((entry, row) => row === index ? { label: value } : entry); clearOutcome(); render(); }
  function addChoiceOption() { if (state.busyAction || state.acroFormChoiceOptions.length >= 50) return; state.acroFormChoiceOptions = [...state.acroFormChoiceOptions, { label: `Option ${state.acroFormChoiceOptions.length + 1}` }]; clearOutcome(); render(); }
  function removeChoiceOption(index) { if (state.busyAction || state.acroFormChoiceOptions.length <= 2) return; state.acroFormChoiceOptions = state.acroFormChoiceOptions.filter((_, row) => row !== index); clearOutcome(); render(); }
  function updateRadioGroupName(value) { if (state.busyAction) return; state.acroFormRadioGroupName = value; clearOutcome(); render(); }
  function updateRadioOption(index, key, value) {
    if (state.busyAction) return;
    const options = Array.isArray(state.acroFormRadioOptions) ? state.acroFormRadioOptions : [];
    if (!options[index]) return;
    state.acroFormRadioOptions = options.map((entry, row) => row === index
      ? (key === 'label' || key === 'page' ? { ...entry, [key]: value } : { ...entry, rect: { ...entry.rect, [key]: value } }) : entry);
    clearOutcome(); render();
  }
  function addRadioOption() {
    if (state.busyAction) return;
    const options = Array.isArray(state.acroFormRadioOptions) ? state.acroFormRadioOptions : [];
    if (options.length >= 10) return;
    state.acroFormRadioOptions = [...options, { label: `Option ${options.length + 1}`, page: '1', rect: { x: 36, y: 36 + options.length * 28, width: 18, height: 18 } }];
    clearOutcome(); render();
  }
  function removeRadioOption(index) {
    if (state.busyAction) return;
    const options = Array.isArray(state.acroFormRadioOptions) ? state.acroFormRadioOptions : [];
    if (options.length <= 2 || !Number.isSafeInteger(index)) return;
    state.acroFormRadioOptions = options.filter((_, row) => row !== index);
    clearOutcome(); render();
  }

  async function run(kind) {
    if (!canRun(kind)) return;
    let request;
    try { request = kind === 'checkbox' ? snapshotCheckbox(state) : kind === 'radio' ? snapshotRadio(state) : kind === 'choice' ? snapshotChoice(state) : snapshotTextField(state); } catch (error) { state.acroFormStatus = 'error'; state.acroFormError = error.message; render(); return; }
    const operation = captureOperation();
    state.acroFormStatus = 'loading';
    state.acroFormError = null;
    state.acroFormResult = null;
    state.busyAction = kind === 'checkbox' ? 'Creating and validating a checkbox PDF copy…' : kind === 'radio' ? 'Creating and validating a radio-group PDF copy…' : kind === 'choice' ? 'Creating and validating a non-combo list/choice PDF copy…' : 'Creating and validating a passive text-field PDF copy…';
    render();
    try {
      const result = kind === 'checkbox'
        ? await client.addAcroFormCheckbox(operation.documentId, request, { signal: operation.controller.signal })
        : kind === 'radio' ? await client.addAcroFormRadio(operation.documentId, request, { signal: operation.controller.signal })
          : kind === 'choice' ? await client.addAcroFormChoice(operation.documentId, request, { signal: operation.controller.signal })
            : await client.addAcroFormTextField(operation.documentId, request, { signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) {
        state.acroFormStatus = 'idle';
        state.acroFormError = null;
        return;
      }
      const downloaded = await downloadDerivedArtifact(result.artifact, operation, `${result.artifact.displayName} created with a verified passive AcroForm control. The source is unchanged.`);
      const current = operationIsCurrent(operation);
      if (!downloaded || !current) {
        if (!downloaded) state.acroFormStatus = 'cancelled';
        if (!current) {
          state.acroFormStatus = 'idle';
          state.acroFormError = null;
        }
        return;
      }
      state.acroFormResult = result;
      state.acroFormStatus = 'success';
      announce(`${result.artifact.displayName} created. The immutable source is unchanged.`);
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      state.acroFormStatus = error?.code === 'JOB_CANCELLED' || error?.status === 499 ? 'cancelled' : 'error';
      state.acroFormError = error?.message ?? String(error);
      reportOperationError(error, operation);
    } finally {
      finishOperation(operation);
    }
  }

  return Object.freeze({
    runCheckbox: () => run('checkbox'),
    runRadio: () => run('radio'),
    runTextField: () => run('text-field'),
    runChoice: () => run('choice'),
    updateCheckboxFieldName, updateCheckboxPage, updateCheckboxRect,
    updateTextFieldName, updateTextFieldPage, updateTextFieldRect,
    updateRadioGroupName, updateRadioOption, addRadioOption, removeRadioOption,
    updateChoiceFieldName, updateChoicePage, updateChoiceRect, updateChoiceOption, addChoiceOption, removeChoiceOption,
  });
}
