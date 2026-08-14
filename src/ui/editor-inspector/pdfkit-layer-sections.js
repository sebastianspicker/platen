import { escapeHtml } from '../shared.js';
import { pdfkitLayerDefaultsResult } from '../editor-result-views.js';

function layerStatus(state) {
  if (state.pdfkitLayerStatus === 'loading') return '<p class="field-help" role="status">Creating and validating a separate layer-visibility PDF…</p>';
  if (state.pdfkitLayerStatus === 'cancelled') return '<p class="field-help" role="status">Layer visibility operation cancelled. The source PDF is unchanged.</p>';
  if (state.pdfkitLayerStatus === 'error' && state.pdfkitLayerError) return `<p class="field-help error-text" role="alert">${escapeHtml(state.pdfkitLayerError)}</p>`;
  if (state.pdfkitLayerStatus === 'success') return '<p class="field-help" role="status">A verified layer-visibility copy was downloaded. The immutable source is unchanged.</p>';
  return '';
}

export function pdfkitLayerSections(state) {
  const inspection = state.pdfkitInspectionResult;
  const inventory = inspection?.optionalContent;
  const inspectedGroups = Array.isArray(inventory?.groups) ? inventory.groups : [];
  const groups = Array.isArray(state.pdfkitLayerGroups) && state.pdfkitLayerGroups.length
    ? state.pdfkitLayerGroups
    : inspectedGroups.map((group) => ({
      index: group.index,
      name: group.name ?? `Unnamed group ${group.index + 1}`,
      defaultVisible: group.defaultVisible,
    }));
  const bound = inspection?.sourceDigest === state.analysis?.sha256
    && state.pdfkitLayerInspectionDigest === state.analysis?.sha256;
  const serviceReady = state.host?.layerDefaultsReady === true;
  const complete = inventory?.present === true && inventory.defaultConfigurationPresent === true
    && inventory.groupsTruncated !== true && groups.length === inventory.groupCount
    && groups.every(({ defaultVisible }) => typeof defaultVisible === 'boolean');
  const available = bound && serviceReady && complete;
  const disabled = available && !state.busyAction ? '' : 'disabled';
  const visibility = Array.isArray(state.pdfkitLayerVisibility) && state.pdfkitLayerVisibility.length
    ? state.pdfkitLayerVisibility : groups.map(({ defaultVisible }) => defaultVisible);
  let explanation = 'Run the pinned PDFKit inspection to bind optional-content groups to this exact source digest.';
  if (inspection && !serviceReady) explanation = 'The local layer-defaults service is unavailable; layer controls are disabled.';
  else if (inspection && !bound) explanation = 'The inspection is stale for the open source. Run it again before changing layer defaults.';
  else if (inventory?.present !== true) explanation = 'This PDF has no optional-content groups in the inspected catalog.';
  else if (inventory.defaultConfigurationPresent !== true || inventory.groupsTruncated === true) explanation = 'The layer inventory is incomplete or has no complete default configuration; controls are disabled.';
  const changes = groups.filter((group, index) => visibility[index] !== group.defaultVisible);
  return `<section class="property-section pdfkit-layer-section" aria-labelledby="pdfkit-layer-heading">
    <h3 id="pdfkit-layer-heading">Optional-content layers</h3>
    <p class="field-help">${escapeHtml(explanation)} Changes are applied only to a separate derived PDF; the immutable source stays unchanged.</p>
    ${groups.length ? `<div class="layer-list" role="group" aria-label="Optional-content layer visibility">${groups.map((group, index) => `<label class="layer-row" for="pdfkit-layer-${group.index}"><input id="pdfkit-layer-${group.index}" type="checkbox" data-pdfkit-layer-index="${group.index}" ${visibility[index] ? 'checked' : ''} ${disabled} /><span>${escapeHtml(group.name)}</span><small>default ${group.defaultVisible ? 'visible' : 'hidden'}</small></label>`).join('')}</div>` : (inventory?.present && complete ? '<p class="field-help">No optional-content groups were reported.</p>' : '')}
    <div class="button-row"><button class="button" data-action="reset-pdfkit-layers" ${disabled}>Reset to inspected defaults</button><button class="button primary" data-action="apply-pdfkit-layers" ${disabled || changes.length === 0 ? 'disabled' : ''}>Apply to derived PDF</button></div>
    ${layerStatus(state)}
    ${pdfkitLayerDefaultsResult(state)}
  </section>`;
}
