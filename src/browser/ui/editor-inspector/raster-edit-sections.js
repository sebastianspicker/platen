import { escapeHtml } from '../shared.js';
import { fullPageRedactionResult } from '../editor-result-views.js';

function selectedPlan(state) {
  return state.redactionPlans?.find(({ id }) => id === state.selectedRedactionPlanId)
    ?? state.redactionPlans?.[0]
    ?? null;
}

function redactionPlanControls(state, ready, reportReady) {
  const plans = state.redactionPlans ?? [];
  const plan = selectedPlan(state);
  const mark = plan?.marks.find(({ id }) => id === state.selectedRedactionMarkId)
    ?? plan?.marks[0]
    ?? null;
  const planOptions = plans.length
    ? plans.map((entry, index) => `<option value="${escapeHtml(entry.id)}" ${entry.id === plan?.id ? 'selected' : ''}>Proposal ${index + 1} · ${entry.marks.length} mark${entry.marks.length === 1 ? '' : 's'}</option>`).join('')
    : '<option value="">No source-bound proposals</option>';
  const markOptions = plan?.marks.map((entry, index) => `<option value="${escapeHtml(entry.id)}" ${entry.id === mark?.id ? 'selected' : ''}>Mark ${index + 1} · page ${entry.page} · ${entry.fullPage === true ? 'full page' : 'region'}</option>`).join('')
    ?? '<option value="">No reviewed marks</option>';
  return `<div class="redaction-plan-controls">
            <h4>Reviewed proposal bridge</h4>
            <p class="field-help">Store the current geometry as a source-bound proposal. The host derives a keyed text binding from its immutable private copy; extracted text, snippets, and the binding key are never returned or stored as plaintext.</p>
            <button class="button" data-action="create-redaction-plan" ${ready ? '' : 'disabled'}>Store current geometry as proposal</button>
            <label class="field-label" for="redaction-plan-select">Source-bound proposal</label>
            <select id="redaction-plan-select" ${ready && plans.length ? '' : 'disabled'}>${planOptions}</select>
            <label class="field-label" for="redaction-mark-select">Reviewed mark</label>
            <select id="redaction-mark-select" ${ready && mark ? '' : 'disabled'}>${markOptions}</select>
            <button class="button danger-button" data-action="apply-redaction-plan" ${ready && mark ? '' : 'disabled'}>Create copy from selected proposal mark</button>
            <button class="button" data-action="export-redaction-plan-report" ${reportReady && plan ? '' : 'disabled'}>Export proposal report</button>
            <p class="field-help">Selection never applies a proposal. Applying requires a fresh confirmation and exact source/workspace binding, re-extracts the region text locally, and records only the plan/geometry link in the separate artifact provenance. The proposal remains proposed-not-applied.</p>
            <p class="field-help">The JSON report contains only source, workspace, plan, and public geometry bindings. It omits extracted text and private binding evidence, changes no PDF bytes, and is not a redaction certificate or application report.</p>
          </div>`;
}

export function rasterEditSections(state, { ready, rasterAvailable, redactionPlanReady, redactionPlanReportReady, fullPageRedactionReady }) {
  const planReady = Boolean(redactionPlanReady);
  return `
      <section class="property-section raster-section">
        <h3>Raster-derived editing</h3>
        <div class="page-transform-grid">
          <button class="button" data-raster-operation="rotate" ${ready && rasterAvailable ? '' : 'disabled'}>Rotate selected 90°</button>
          <button class="button" data-raster-operation="flatten" ${ready && rasterAvailable ? '' : 'disabled'}>Flatten all pages</button>
        </div>
        <details>
          <summary>Crop selected page</summary>
          <div class="numeric-grid">
            <label>X <input id="crop-x" type="number" min="0" max="0.99" step="0.01" value="${escapeHtml(state.cropRegion?.x ?? 0.05)}" /></label>
            <label>Y <input id="crop-y" type="number" min="0" max="0.99" step="0.01" value="${escapeHtml(state.cropRegion?.y ?? 0.05)}" /></label>
            <label>Width <input id="crop-width" type="number" min="0.01" max="1" step="0.01" value="${escapeHtml(state.cropRegion?.width ?? 0.9)}" /></label>
            <label>Height <input id="crop-height" type="number" min="0.01" max="1" step="0.01" value="${escapeHtml(state.cropRegion?.height ?? 0.9)}" /></label>
          </div>
          <button class="button" data-raster-operation="crop" ${ready && rasterAvailable ? '' : 'disabled'}>Crop selected page</button>
        </details>
        <details>
          <summary>Resize selected page</summary>
          <div class="numeric-grid">
            <label>Width pt <input id="resize-width" type="number" min="64" max="2048" step="1" value="${escapeHtml(state.resizeWidth ?? 612)}" /></label>
            <label>Height pt <input id="resize-height" type="number" min="64" max="2048" step="1" value="${escapeHtml(state.resizeHeight ?? 792)}" /></label>
          </div>
          <button class="button" data-raster-operation="resize" ${ready && rasterAvailable ? '' : 'disabled'}>Resize selected page</button>
        </details>
        <details>
          <summary>Add recurring text</summary>
          <label class="field-label" for="overlay-placement">Placement</label>
          <select id="overlay-placement">
            ${[['watermark', 'Watermark'], ['header', 'Header'], ['footer', 'Footer'], ['bates', 'Bates / page ID']].map(([value, label]) => `<option value="${value}" ${state.overlayPlacement === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <label class="field-label" for="overlay-text">Text; use {page} for page number</label>
          <input id="overlay-text" maxlength="256" value="${escapeHtml(state.overlayText ?? 'CONFIDENTIAL')}" />
          <button class="button" data-raster-operation="overlay" ${ready && rasterAvailable ? '' : 'disabled'}>Apply to all pages</button>
        </details>
        <details class="redaction-controls">
          <summary>Verified raster-burn redaction</summary>
          <h4>Direct one-off target</h4>
          <label class="field-label" for="redaction-text">Exact source text expected on selected page</label>
          <input id="redaction-text" maxlength="256" value="${escapeHtml(state.redactionText ?? '')}" placeholder="Text that must be removed" />
          <label class="field-label" for="redaction-full-page"><input id="redaction-full-page" type="checkbox" ${state.redactionFullPage ? 'checked' : ''} /> Redact the entire selected page</label>
          <div class="numeric-grid">
            <label>X <input id="redact-x" type="number" min="0" max="0.99" step="0.01" ${state.redactionFullPage ? 'disabled' : ''} value="${escapeHtml(state.redactionRegion?.x ?? 0.1)}" /></label>
            <label>Y <input id="redact-y" type="number" min="0" max="0.99" step="0.01" ${state.redactionFullPage ? 'disabled' : ''} value="${escapeHtml(state.redactionRegion?.y ?? 0.1)}" /></label>
            <label>Width <input id="redact-width" type="number" min="0.01" max="1" step="0.01" ${state.redactionFullPage ? 'disabled' : ''} value="${escapeHtml(state.redactionRegion?.width ?? 0.4)}" /></label>
            <label>Height <input id="redact-height" type="number" min="0.01" max="1" step="0.01" ${state.redactionFullPage ? 'disabled' : ''} value="${escapeHtml(state.redactionRegion?.height ?? 0.08)}" /></label>
          </div>
          <button class="button danger-button" data-raster-operation="redact" ${ready && rasterAvailable ? '' : 'disabled'}>Create image-only redacted copy</button>
          <p class="field-help">The verified-raster-burn-v2 profile creates an irreversible raster-derived, image-only copy. It binds the exact text to the selected region, or to the entire selected page when enabled, proves target pixels are opaque black and non-target pixels unchanged, then rejects output with extractable text, signatures, attachments, URLs, forms, JavaScript, or unexpected metadata. Rotated pages and pages whose CropBox differs from MediaBox are currently unsupported. This is not object-level sanitization, object-preserving redaction, or selective sanitization; the immutable source remains unchanged.</p>
          <div class="nested-control-group" role="group" aria-label="Object-level full-page redaction">
            <h4>Object-level full-page redaction</h4>
            <button class="button danger-button" data-action="create-full-page-object-redaction" ${fullPageRedactionReady ? '' : 'disabled'}>Create closed full-page redaction copy</button>
            <p class="field-help">Replaces the selected page's content and reachable resources in a closed compact PDF rewrite, then checks that the target text is gone, the target render is black, and every non-target text/render is unchanged. This is full-page-only object redaction, not region redaction or whole-document sanitization. Unsupported active, signed, encrypted, or shared-resource sources fail closed.</p>
          </div>
          ${fullPageRedactionResult(state)}
          ${redactionPlanControls(state, planReady, Boolean(redactionPlanReportReady))}
        </details>
        <p class="field-help">Raster edits deliberately discard vectors, links, forms, tags, layers, and signatures. Every result is a separate validated PDF.</p>
      </section>`;
}
