import { icon } from './icons.js';
import { brandAndMenu, errorBanner, escapeHtml, rail } from './shared.js';

const groupDetails = Object.freeze({
  review: { label: 'Review', description: 'Annotations, replies, tracking, and bounded interchange.' },
  forms: { label: 'Forms', description: 'Session-only field definitions, values, and validation.' },
  redaction: { label: 'Redaction', description: 'Detection and proposals; no PDF bytes are changed.' },
  accessibility: { label: 'Accessibility', description: 'Inspection reports and remediation proposals.' },
  signing: { label: 'Signing', description: 'Local intent records and audit-chain checks.' },
  AEC: { label: 'AEC', description: 'Local measurement, markup, takeoff, and drawing records.' },
  collaboration: { label: 'Collaboration', description: 'Offline project, review, and version records.' },
});

function humanize(value) {
  return String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function groups(operations) {
  return Object.entries(operations ?? {}).map(([id, entries]) => ({
    id,
    label: groupDetails[id]?.label ?? humanize(id),
    description: groupDetails[id]?.description ?? 'Local prototype domain operations.',
    entries: Object.entries(entries ?? {}).map(([name, details]) => ({ name, ...details })),
  }));
}

function operationButton(group, entry, selected) {
  const isSelected = selected?.group === group.id && selected?.operation === entry.name;
  const disabled = !entry.supported;
  return `<button class="workflow-operation ${isSelected ? 'is-selected' : ''}" data-domain-group="${escapeHtml(group.id)}" data-domain-operation="${escapeHtml(entry.name)}" ${disabled ? 'disabled aria-disabled="true"' : ''} aria-pressed="${isSelected ? 'true' : 'false'}" title="${escapeHtml(entry.semantics ?? '')}">
    <span class="workflow-operation-copy"><strong>${escapeHtml(humanize(entry.name))}</strong><small>${escapeHtml(entry.semantics ?? 'No semantics supplied by the local host.')}</small></span>
    <span class="workflow-operation-state ${entry.supported ? 'is-available' : 'is-unsupported'}">${entry.supported ? 'Available' : 'Unsupported'}</span>
  </button>`;
}

function operationGroups(operations, selected) {
  const list = groups(operations);
  if (!list.length) {
    return `<section class="workflow-state workflow-state-loading" role="status"><span class="spinner" aria-hidden="true"></span><div><h2>Loading local workflows…</h2><p>The local host has not supplied its domain operation list yet.</p></div></section>`;
  }
  if (!list.some((group) => group.entries.length)) {
    return `<section class="workflow-state workflow-state-empty"><h2>No local workflows available</h2><p>The local host returned no document-scoped operations for this session.</p></section>`;
  }
  return list.filter((group) => group.entries.length).map((group) => `<section class="workflow-group" aria-labelledby="workflow-group-${escapeHtml(group.id)}">
    <div class="workflow-group-heading"><div><h2 id="workflow-group-${escapeHtml(group.id)}">${escapeHtml(group.label)}</h2><p>${escapeHtml(group.description)}</p></div><span class="workflow-group-count">${group.entries.length} operation${group.entries.length === 1 ? '' : 's'}</span></div>
    <div class="workflow-operation-list">${group.entries.map((entry) => operationButton(group, entry, selected)).join('')}</div>
  </section>`).join('');
}

function resultPanel(result, error, busy) {
  const state = error ? 'error' : busy ? 'running' : result === undefined || result === null ? 'idle' : 'ready';
  const label = error ? 'Operation error' : busy ? 'Running local operation' : result === undefined || result === null ? 'Result' : 'Local result';
  const content = error ? escapeHtml(error) : busy ? 'Working with the local session sidecar…' : result === undefined || result === null ? 'Select an available operation, provide a JSON body if needed, and run it against the open local document.' : escapeHtml(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  const stateText = state === 'ready' ? 'Recorded locally' : state === 'error' ? 'Needs attention' : state === 'running' ? 'Working' : 'Waiting';
  const announce = state === 'idle' ? '' : `<p class="workflow-result-state" role="status">${stateText}</p>`;
  return `<section class="workflow-result workflow-result-${state}" aria-labelledby="workflow-result-label"><div><h2 id="workflow-result-label">${label}</h2>${announce}</div><pre>${content}</pre></section>`;
}

function aecArtifactPanel(state, hasDocument) {
  const canRecord = Boolean(hasDocument && state.host?.aecArtifactsReady && !state.domainBusy && !state.busyAction);
  const canPublish = Boolean(canRecord && state.host?.aecNativeReady && state.aecLastMeasurementId);
  return `<section class="workflow-module aec-artifact-panel" aria-labelledby="aec-artifact-heading">
    <div class="workflow-module-heading"><h2 id="aec-artifact-heading">AEC measurement artifacts</h2><span>Source-bound geometry</span></div>
    <p>Enter unrotated PDF user-space points for page ${escapeHtml(state.selectedPage ?? 1)}. The host binds them to the immutable PDF SHA-256, exact CropBox, page rotation, and workspace revision.</p>
    <label class="field-label" for="aec-calibration-points">Calibration segment</label>
    <input id="aec-calibration-points" value="${escapeHtml(state.aecCalibrationPoints ?? '')}" placeholder="36,36;108,36" ${canRecord ? '' : 'disabled'}>
    <div class="workflow-module-actions">
      <input id="aec-real-length" type="number" min="0.000001" step="any" value="${escapeHtml(state.aecRealLength ?? '1')}" aria-label="Known calibration length" ${canRecord ? '' : 'disabled'}>
      <select id="aec-calibration-unit" aria-label="Calibration unit" ${canRecord ? '' : 'disabled'}>${['mm', 'cm', 'm', 'in', 'ft'].map((unit) => `<option value="${unit}" ${state.aecCalibrationUnit === unit ? 'selected' : ''}>${unit}</option>`).join('')}</select>
      <button class="button" data-action="create-aec-calibration" ${canRecord ? '' : 'disabled'}>Calibrate</button>
    </div>
    <label class="field-label" for="aec-measurement-points">Measurement points</label>
    <input id="aec-measurement-points" value="${escapeHtml(state.aecMeasurementPoints ?? '')}" placeholder="36,36;108,36" ${canRecord ? '' : 'disabled'}>
    <div class="workflow-module-actions">
      <select id="aec-measurement-kind" aria-label="Measurement kind" ${canRecord ? '' : 'disabled'}>${['distance', 'perimeter', 'area', 'count'].map((kind) => `<option value="${kind}" ${state.aecMeasurementKind === kind ? 'selected' : ''}>${humanize(kind)}</option>`).join('')}</select>
      <select id="aec-display-unit" aria-label="Measurement display unit" ${canRecord ? '' : 'disabled'}>${['mm', 'cm', 'm', 'in', 'ft', 'mm2', 'cm2', 'm2', 'in2', 'ft2', 'count'].map((unit) => `<option value="${unit}" ${state.aecDisplayUnit === unit ? 'selected' : ''}>${unit}</option>`).join('')}</select>
      <button class="button" data-action="create-aec-measurement" ${canRecord && (state.aecMeasurementKind === 'count' || state.aecLastCalibrationId) ? '' : 'disabled'}>Measure</button>
    </div>
    <label class="field-label" for="aec-measurement-label">Artifact label</label>
    <input id="aec-measurement-label" value="${escapeHtml(state.aecMeasurementLabel ?? '')}" maxlength="160" ${canRecord ? '' : 'disabled'}>
    <button class="button primary" data-action="publish-aec-measurement" ${canPublish ? '' : 'disabled'}>Create separate annotated PDF</button>
    <button class="button" data-action="generate-aec-measurement-legend" ${hasDocument && state.host?.aecMeasurementLegendReady && state.aecMeasurementIds?.length && !state.domainBusy && !state.busyAction ? '' : 'disabled'}>Generate measurement legend</button>
    ${state.aecLegendStatus === 'loading' ? '<p class="field-help" role="status">Generating and validating the current workspace legend…</p>' : state.aecLegendStatus === 'cancelled' ? '<p class="field-help" role="status">Legend generation cancelled; no file was downloaded.</p>' : state.aecLegendStatus === 'stale' ? '<p class="field-help" role="status">The workspace changed; refresh the current legend before downloading.</p>' : state.aecLegendStatus === 'error' ? `<p class="field-help error-text" role="alert">${escapeHtml(state.aecLegendError ?? 'Legend generation failed.')}</p>` : state.aecLegendStatus === 'success' ? '<p class="field-help" role="status">Current-revision source-bound legend downloaded. Labels are represented only as digests.</p>' : ''}
    <p class="field-help">${state.host?.aecNativeReady ? 'Publication creates inert PDF line, ink, or circle annotations, adds a bounded ISO/PDF Measure scale for calibrated geometry, and independently reparses and renders the separate result.' : 'Calculation is available, but PDF-native publication requires the pinned macOS PDFKit helper.'} Count stays uncalibrated; no complete AEC or standards-conformance claim is made.</p>
  </section>`;
}

function scannerDiscoveryPanel(state) {
  const ready = state.host?.scannerDiscoveryReady === true;
  const devices = state.scannerDevices ?? [];
  const status = state.scannerDiscoveryStatus;
  const message = status === 'loading' ? '<p class="field-help" role="status">Checking local scanner discovery…</p>'
    : status === 'cancelled' ? '<p class="field-help" role="status">Scanner discovery cancelled.</p>'
      : status === 'error' ? `<p class="field-help error-text" role="alert">${escapeHtml(state.scannerDiscoveryError ?? 'Scanner discovery failed.')}</p>` : '';
  const list = status === 'success' ? `<ul class="field-help" aria-label="Discovered scanners">${devices.length ? devices.map((device) => `<li>${escapeHtml(device.name)} <span class="state-pill implemented">Discovery only</span></li>`).join('') : '<li>No scanners were returned by the local discovery API.</li>'}</ul>` : '';
  return `<section class="workflow-module scanner-discovery-panel" aria-labelledby="scanner-discovery-heading">
    <div class="workflow-module-heading"><h2 id="scanner-discovery-heading">Scanner discovery</h2><span>Image acquisition boundary</span></div>
    <p>Lists locally discoverable scanner devices through ImageCaptureCore. This is discovery only: scan acquisition, destinations, serials, and raw paths are not exposed.</p>
    <button class="button" data-action="discover-scanners" ${ready && !state.busyAction ? '' : 'disabled'}>Discover scanners</button>
    ${message}${list}
    <p class="field-help">${ready ? 'No scan or acquisition claim is made.' : 'The pinned scanner discovery helper is unavailable on this host.'}</p>
  </section>`;
}
function batesPanel(state, hasDocument) {
  const ready = hasDocument && state.host?.batesNumberingReady === true && !state.busyAction;
  const disabled = ready ? '' : 'disabled';
  const status = state.batesStatus === 'loading' ? '<p class="field-help" role="status">Creating and independently validating Bates output…</p>' : state.batesStatus === 'cancelled' ? '<p class="field-help" role="status">Bates numbering cancelled; no file was downloaded.</p>' : state.batesStatus === 'error' ? `<p class="field-help error-text" role="alert">${escapeHtml(state.batesError ?? 'Bates numbering failed.')}</p>` : state.batesStatus === 'success' ? '<p class="field-help" role="status">Source-bound Bates PDF downloaded.</p>' : '';
  const positions = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];
  return `<section class="workflow-module" aria-labelledby="bates-heading">
    <div class="workflow-module-heading"><h2 id="bates-heading">Bates numbering</h2><span>Source-bound page IDs</span></div>
    <p>Adds passive Bates text to selected pages in a separate PDF. The immutable source remains unchanged; no signature or standards claim is made.</p>
    <label class="field-label" for="bates-pages">Pages</label><input id="bates-pages" value="${escapeHtml(state.batesPages ?? '1')}" placeholder="1,3-5" ${disabled}>
    <div class="inline-fields"><input id="bates-start" type="number" value="${escapeHtml(state.batesStart ?? '0')}" aria-label="Bates start" ${disabled}><input id="bates-prefix" value="${escapeHtml(state.batesPrefix ?? '')}" aria-label="Bates prefix" ${disabled}><input id="bates-suffix" value="${escapeHtml(state.batesSuffix ?? '')}" aria-label="Bates suffix" ${disabled}><input id="bates-padding" type="number" min="1" max="12" value="${escapeHtml(state.batesPadding ?? '6')}" aria-label="Bates padding" ${disabled}></div>
    <div class="inline-fields"><select id="bates-position" aria-label="Bates position" ${disabled}>${positions.map((position) => `<option value="${position}" ${state.batesPosition === position ? 'selected' : ''}>${position}</option>`).join('')}</select><input id="bates-margin" type="number" value="${escapeHtml(state.batesMargin ?? '12')}" aria-label="Bates margin" ${disabled}><input id="bates-font-size" type="number" value="${escapeHtml(state.batesFontSize ?? '10')}" aria-label="Bates font size" ${disabled}></div>
    <button class="button" data-action="run-bates-numbering" ${disabled}>Create Bates-numbered PDF</button>${status}
  </section>`;
}

export function workflowsView(state) {
  const operations = state.domainOperations;
  const selected = state.selectedDomainOperation;
  const hasDocument = Boolean(state.document?.isOpen && (state.analysis?.documentId || state.document?.id));
  const selectedEntry = selected && operations?.[selected.group]?.[selected.operation];
  const runnerMode = operations == null ? 'loading' : !hasDocument ? 'no-document' : selectedEntry?.supported ? 'ready' : 'unavailable';
  const runnerReady = runnerMode === 'ready';
  const runnerStatus = runnerMode === 'loading'
    ? hasDocument
      ? { title: 'Operation map loading', detail: 'Request editing and local execution stay disabled until the local host supplies its workflow map.' }
      : { title: 'Workflow runner unavailable', detail: 'Open a local PDF and wait for the local host to supply its workflow map.' }
    : runnerMode === 'no-document'
      ? { title: 'Open a local PDF', detail: 'Request editing and local execution stay disabled until a document is open.' }
      : runnerMode === 'unavailable'
        ? { title: 'No available operation selected', detail: 'Choose a supported operation before editing or running a request.' }
        : null;
  const selectedGroup = runnerReady ? escapeHtml(humanize(selected.group)) : escapeHtml(runnerStatus.title);
  const selectedOperation = runnerReady ? escapeHtml(humanize(selected.operation)) : escapeHtml(runnerStatus.detail);
  const canRun = Boolean(runnerReady && !state.domainBusy);
  const canUseProjectBundle = Boolean(hasDocument && state.host?.portableProjectBundlesReady && !state.domainBusy && !state.busyAction);
  const payload = state.domainPayload ?? '{}';
  return `<div class="app-shell workflow-shell">
    ${brandAndMenu('workflows', {
      context: hasDocument ? state.document.name : 'No source open',
    })}
    <header class="workflow-proof-bar" aria-label="Workflow context">
      <span><strong>Local workflow map</strong></span>
      <span><strong>${hasDocument ? escapeHtml(state.document.name) : 'No document open'}</strong></span>
      <span><strong>Source remains unchanged</strong></span>
      <button class="button" data-action="show-editor">Return to Workspace</button>
    </header>
    <main class="workflow-layout" id="workspace" tabindex="-1">
      ${rail('workflows')}
      <section class="workflow-main" aria-label="Local workflows">
        <header class="workflow-header"><div><h1>Document operations</h1><p>Select one bounded local operation, inspect its exact request, then run it against the current source-bound workspace.</p></div></header>
        <div class="workflow-context" role="status">${hasDocument ? `Working with <strong>${escapeHtml(state.document.name)}</strong> in this local session.` : 'Open a local PDF in the editor to run document-scoped operations. The operation map remains available to review.'}</div>
        <div class="workflow-groups">${operationGroups(operations, selected)}</div>
      </section>
      <aside class="workflow-runner" aria-label="${runnerReady ? 'Run selected workflow' : 'Workflow runner unavailable'}" data-state="${runnerMode}">
        <div class="workflow-runner-heading"><h2>${runnerReady ? 'Selected operation' : 'Workflow runner'}</h2><p class="workflow-selection${runnerReady ? '' : ' workflow-selection-unavailable'}" ${runnerReady ? '' : 'role="status"'}><strong>${selectedGroup}</strong><span>${selectedOperation}</span></p></div>
        <label class="field-label" for="domain-payload">JSON request body</label>
        <textarea id="domain-payload" class="domain-payload" rows="13" spellcheck="false" aria-describedby="domain-payload-help" ${!runnerReady || state.domainBusy ? 'disabled' : ''}>${escapeHtml(payload)}</textarea>
        <p class="field-help" id="domain-payload-help">${runnerReady ? 'Use only the body expected by this local operation. Records are session-only sidecar records or explicit proposals; no remote sync occurs.' : selectedOperation}</p>
        <button class="button primary workflow-run-button" data-action="run-domain-operation" ${canRun ? '' : 'disabled'}>Run locally</button>
        <details class="workflow-specialist-tools">
          <summary><span><strong>Specialist assets &amp; projects</strong><small>AEC, scanner, Bates, and portable project utilities</small></span>${icon('chevronDown')}</summary>
          <div class="workflow-specialist-body">
            ${aecArtifactPanel(state, hasDocument)}
            ${scannerDiscoveryPanel(state)}
            ${batesPanel(state, hasDocument)}
            <section class="workflow-module" aria-labelledby="project-bundle-heading">
              <div class="workflow-module-heading"><h2 id="project-bundle-heading">Portable PDF project</h2><span>Self-contained project</span></div>
              <p>Export the exact PDF bytes together with the complete revisioned, digest-bound workspace, or validate and open one as a new local session.</p>
              <div class="workflow-module-actions">
                <button class="button" data-action="export-project-bundle" ${canUseProjectBundle ? '' : 'disabled'}>Export project</button>
                <button class="button" data-action="choose-project-bundle" ${state.host?.portableProjectBundlesReady && !state.domainBusy && !state.busyAction ? '' : 'disabled'}>Open project</button>
              </div>
              <input id="project-bundle-picker" type="file" accept=".platen-project,application/vnd.platen.portable-project" aria-label="Choose a local Platen portable project" hidden>
              <p class="field-help">The bounded local container uses a canonical manifest and verifies both the embedded PDF SHA-256 and workspace digest before opening. It contains no secrets, paths, executable content, or network synchronization.</p>
            </section>
          </div>
        </details>
        ${runnerReady ? resultPanel(state.domainResult, state.domainError, state.domainBusy) : ''}
        <p class="workflow-boundary"><strong>Trust boundary:</strong> certificate signing, trust, revocation, LTV, digital ID, irreversible flattening, and applying redactions are visibly unsupported. Local signing results are not certificate validation. This workflow never claims PDF-byte mutation, certificate trust, or remote synchronization.</p>
      </aside>
    </main>
    <footer class="status-bar workflow-status" role="status">
      <span>${icon(state.domainBusy ? 'rotate' : 'check')} ${state.domainBusy ? 'Local operation running' : 'Workflow desk ready'}</span>
      <span class="status-spacer"></span>
      <span>${hasDocument ? 'Source-bound workspace' : 'Review-only until a PDF is opened'}</span>
    </footer>
    ${errorBanner(state.error)}
  </div>`;
}
