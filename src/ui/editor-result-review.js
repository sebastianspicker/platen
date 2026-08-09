import { escapeHtml } from './shared.js';

export function fullPageRedactionResult(state) {
  const result = state.fullPageRedactionResult;
  if (result?.kind !== 'pdf-full-page-redaction') return '';
  return `<div class="comparison-result" role="status"><strong>Object-level full-page redaction PDF created</strong><span>${escapeHtml(result.artifact?.displayName ?? 'Full-page redaction PDF')} · page ${escapeHtml(result.redaction?.page ?? '')} · closed compact rewrite</span><span>Target page content and reachable resources were removed from the closed output; non-target text and renders were independently preserved.</span><span>This is full-page-only object redaction, not region redaction or whole-document sanitization. The immutable source remains unchanged.</span>${(result.limitations ?? []).map((limitation) => `<span>${escapeHtml(limitation)}</span>`).join('')}</div>`;
}

function base64PngData(image) {
  return image?.mediaType === 'image/png' && image?.encoding === 'base64'
    && /^[A-Za-z0-9+/=]+$/u.test(image.data ?? '') ? image.data : null;
}

function sideBySidePanes(report) {
  if (report?.kind !== 'side-by-side' || !Array.isArray(report.panes)) return '';
  const labels = ['Primary PDF · left pane', 'Secondary PDF · right pane'];
  const panes = report.panes.slice(0, 2).map((pane, index) => {
    const data = base64PngData(pane);
    if (!data || pane.role !== (index === 0 ? 'primary' : 'secondary')) return '';
    return `<figure class="comparison-difference"><img src="data:image/png;base64,${data}" alt="${labels[index]} for page ${escapeHtml(report.page)}" /><figcaption>${labels[index]} · page ${escapeHtml(report.page)}</figcaption></figure>`;
  });
  return panes.every(Boolean) ? `<div class="comparison-images">${panes.join('')}</div>` : '';
}

function comparisonSummary(report, effective) {
  const stats = effective?.stats ?? {};
  if (report.kind === 'side-by-side') return 'Two independent local page panes rendered for review.';
  if (effective?.kind === 'pixel') return `${stats.changedPixels ?? 0} changed of ${stats.comparedPixels ?? 0} compared pixels`;
  if (effective?.kind === 'content') return `${stats.added ?? 0} added · ${stats.deleted ?? 0} deleted · ${stats.unchanged ?? 0} unchanged tokens`;
  if (effective?.kind === 'annotations') return `${stats.added ?? 0} added · ${stats.deleted ?? 0} deleted · ${stats.changed ?? 0} changed annotations`;
  return 'Local comparison report ready.';
}

export function comparisonResult(state) {
  const report = state.comparisonReport;
  if (!report) return '';
  const effective = report.kind === 'cross-format' ? report.content : report;
  const summary = comparisonSummary(report, effective);
  const images = (effective?.pages ?? [])
    .filter((page) => page?.differenceImage?.encoding === 'base64'
      && /^[A-Za-z0-9+/=]+$/.test(page.differenceImage.data ?? ''))
    .slice(0, 4)
    .map((page) => `<figure class="comparison-difference"><img src="data:image/png;base64,${page.differenceImage.data}" alt="Pixel differences for page ${page.page}" /><figcaption>Page ${page.page} difference mask</figcaption></figure>`)
    .join('');
  return `<div class="comparison-result" role="status">
    <strong>${escapeHtml(state.comparisonFileName ?? 'Comparison PDF')}</strong>
    <span>${escapeHtml(summary)}</span>
    ${sideBySidePanes(report)}
    ${images ? `<div class="comparison-images">${images}</div>` : ''}
    <div class="button-row"><button class="button" data-action="export-comparison-json">Export JSON</button><button class="button" data-action="export-comparison-csv">Export CSV</button></div>
  </div>`;
}

export function prepressResult(state) {
  const result = state.prepressResult;
  if (!result) return '';
  if (result.kind === 'preflight-review') {
    const checks = Array.isArray(result.checks) ? result.checks.slice(0, 16) : [];
    const statusLabel = result.status === 'fail'
      ? 'Known failures'
      : result.status === 'pass' ? 'Passed fixed checks' : 'Human review required';
    return `<div class="comparison-result preflight-result" role="status">
      <strong>${escapeHtml(result.profile?.id ?? 'Fixed preflight review')} · ${escapeHtml(statusLabel)}</strong>
      <span>${escapeHtml(result.counts?.pass ?? 0)} passed · ${escapeHtml(result.counts?.warning ?? 0)} warnings · ${escapeHtml(result.counts?.fail ?? 0)} failed · ${escapeHtml(result.counts?.['not-checked'] ?? 0)} not checked</span>
      <ul class="preflight-checks">${checks.map((check) => `<li class="preflight-${escapeHtml(check.status)}"><strong>${escapeHtml(check.id)}</strong><span>${escapeHtml(check.summary)}</span></li>`).join('')}</ul>
      <button class="button" data-action="export-preflight-json">Export JSON review</button>
      <span>This fixed local report is non-authoritative and applies no fixups. It is not PDF/A, PDF/X, PDF/UA, GWG, Ghent, or Certified PDF validation.</span>
    </div>`;
  }
  if (result.kind === 'ink-coverage') {
    const selected = result.pages?.find(({ page }) => page === (state.selectedPage ?? 1));
    const maximum = (result.pages ?? []).reduce(
      (current, item) => Math.max(current, Number(item.totalInkPercent) || 0),
      0,
    );
    return `<div class="comparison-result" role="status">
      <strong>CMYK coverage report</strong>
      <span>${result.pages?.length ?? 0} page${result.pages?.length === 1 ? '' : 's'} · maximum aggregate ${maximum.toFixed(2)}%</span>
      ${selected ? `<span>Page ${selected.page}: C ${(selected.cyan * 100).toFixed(2)}% · M ${(selected.magenta * 100).toFixed(2)}% · Y ${(selected.yellow * 100).toFixed(2)}% · K ${(selected.black * 100).toFixed(2)}%</span>` : ''}
    </div>`;
  }
  if (['icc-cmyk-artifact', 'imposition-artifact', 'output-intent-artifact'].includes(result.kind)) {
    const title = result.kind === 'icc-cmyk-artifact'
      ? 'CMYK ICC-derived PDF ready'
      : result.kind === 'output-intent-artifact'
        ? 'OutputIntent PDF ready'
        : 'Imposed PDF ready';
    return `<div class="comparison-result" role="status">
      <strong>${title}</strong>
      <span>${escapeHtml(result.artifact?.displayName ?? 'Derived PDF')} · downloaded as a separate artifact</span>
      <span>${result.kind === 'output-intent-artifact' ? 'The fixed host CMYK OutputIntent is assigned, but this does not establish PDF/X conformance, colorimetric conformance, press certification, or production-RIP parity.' : 'This local output is not PDF/X certification or a production RIP result.'}</span>
    </div>`;
  }
  if (result.kind === 'print-production-validation') {
    return `<div class="comparison-result preflight-result" role="status">
      <strong>Local production validation · ${escapeHtml(result.status ?? 'review required')}</strong>
      <span>${escapeHtml(result.counts?.pass ?? 0)} passed · ${escapeHtml(result.counts?.warning ?? 0)} warnings · ${escapeHtml(result.counts?.fail ?? 0)} failed · ${escapeHtml(result.counts?.['not-checked'] ?? 0)} not checked</span>
      <span>This result is non-certifying: it is not PDF/X certification, a press approval, or a production RIP result.</span>
    </div>`;
  }
  const images = result.kind === 'separation-preview' ? result.images : [result.image];
  const safeImages = (images ?? [])
    .filter((image) => image?.format === 'image/png'
      && /^[A-Za-z0-9+/=]+$/.test(image.data ?? ''))
    .slice(0, 8);
  return `<div class="comparison-result" role="status">
    <strong>${result.kind === 'separation-preview' ? 'Separation review' : 'Overprint review'}</strong>
    <span>Page ${result.page} · ${result.effectiveDpi} DPI${result.requestedDpi !== result.effectiveDpi ? ` (bounded from ${result.requestedDpi})` : ''}</span>
    <div class="comparison-images">${safeImages.map((image) => `<figure class="comparison-difference"><img src="data:image/png;base64,${image.data}" alt="${escapeHtml(image.label ?? 'Prepress')} preview for page ${result.page}" /><figcaption>${escapeHtml(image.label ?? 'Preview')}</figcaption></figure>`).join('')}</div>
  </div>`;
}

export function standardsValidationResult(state) {
  const result = state.standardsValidationResult;
  if (!result) return '';
  const compliant = result.status === 'compliant';
  return `<div class="comparison-result preflight-result" role="status">
    <strong>${escapeHtml(result.standard?.profile ?? 'Fixed profile')} · ${compliant ? 'Compliant' : 'Noncompliant'}</strong>
    <span>${escapeHtml(result.counts?.passedRules ?? 0)} passed rules · ${escapeHtml(result.counts?.failedRules ?? 0)} failed rules · ${escapeHtml(result.counts?.passedChecks ?? 0)} passed checks · ${escapeHtml(result.counts?.failedChecks ?? 0)} failed checks</span>
    <span>veraPDF ${escapeHtml(result.engine?.version ?? 'unknown')} · complete source-bound result</span>
    <button class="button" data-action="export-standards-validation">Export validation receipt</button>
    <span>This receipt applies only to the named profile and pinned engine version. It is not legal, accessibility-usability, print-production, or PDF/X certification.</span>
  </div>`;
}

export function accessibilityReviewResult(state, {
  accessibilityAltTextEditorReady = false,
  accessibilityAltTextReady = false,
} = {}) {
  const result = state.accessibilityReviewResult;
  if (!result) return '';
  const checks = Array.isArray(result.checks) ? result.checks.slice(0, 20) : [];
  const candidates = Array.isArray(result.remediationPlan?.candidates)
    ? result.remediationPlan.candidates.slice(0, 8) : [];
  const nonImageCandidates = (result.remediationPlan?.candidates ?? [])
    .filter(({ action }) => action !== 'author-image-alt-text');
  const imageCandidates = (result.remediationPlan?.candidates ?? []).filter((candidate) => (
    candidate?.action === 'author-image-alt-text'
      && candidate.status === 'proposed-not-applied'
      && /^[a-f0-9]{64}$/u.test(candidate.target?.locator ?? '')
  ));
  const proposalReady = state.host?.accessibilityRemediationReady
    && result.sourceDigest === state.analysis?.sha256
    && result.remediationPlan?.truncated === false
    && nonImageCandidates.length > 0;
  const statusLabel = result.status === 'fail'
    ? 'Known failures'
    : result.status === 'pass' ? 'Fixed checks passed' : 'Human review required';
  return `<div class="comparison-result preflight-result" role="status">
    <strong>${escapeHtml(result.profile?.id ?? 'basic-local-review')} · ${escapeHtml(statusLabel)}</strong>
    <span>${escapeHtml(result.counts?.pass ?? 0)} passed · ${escapeHtml(result.counts?.warning ?? 0)} warnings · ${escapeHtml(result.counts?.fail ?? 0)} failed · ${escapeHtml(result.counts?.['not-checked'] ?? 0)} not checked</span>
    <ul class="preflight-checks">${checks.map((check) => `<li class="preflight-${escapeHtml(check.status)}"><strong>${escapeHtml(check.id)}</strong><span>${escapeHtml(check.summary ?? check.message ?? '')}</span></li>`).join('')}</ul>
    <strong>${escapeHtml(result.remediationPlan?.candidateCount ?? 0)} source-bound remediation candidate${result.remediationPlan?.candidateCount === 1 ? '' : 's'}</strong>
    ${candidates.length ? `<ul class="preflight-checks">${candidates.map((candidate) => `<li><strong>${escapeHtml(candidate.action)}</strong><span>${escapeHtml(candidate.reason)}</span></li>`).join('')}</ul>` : ''}
    <button class="button" data-action="export-accessibility-review">Export JSON review</button>
    <button class="button" data-action="create-accessibility-proposal" ${proposalReady ? '' : 'disabled'}>Create non-image proposal</button>
    <h4>Author image alternative text</h4>
    <label class="field-label" for="accessibility-alt-text-candidate">Source-bound image candidate</label>
    <select id="accessibility-alt-text-candidate" ${accessibilityAltTextEditorReady ? '' : 'disabled'}>
      <option value="">Select one image candidate</option>
      ${imageCandidates.map(({ target }) => `<option value="${escapeHtml(target.locator)}" ${state.accessibilityAltTextCandidateLocator === target.locator ? 'selected' : ''}>Page ${escapeHtml(target.page ?? 'unknown')} · image ${escapeHtml(target.imageNumber ?? 'unknown')}</option>`).join('')}
    </select>
    <label class="field-label" for="accessibility-alt-text">Human-authored alternative text</label>
    <textarea id="accessibility-alt-text" rows="3" maxlength="1000" ${accessibilityAltTextEditorReady ? '' : 'disabled'}>${escapeHtml(state.accessibilityAltText ?? '')}</textarea>
    <button class="button" data-action="create-accessibility-alt-text-proposal" ${accessibilityAltTextReady ? '' : 'disabled'}>Export alt-text proposal</button>
    ${state.accessibilityAltTextProposalResult ? `<span>Image alt text exported for page ${escapeHtml(state.accessibilityAltTextProposalResult.page ?? 'unknown')}, image ${escapeHtml(state.accessibilityAltTextProposalResult.imageNumber ?? 'unknown')}; status proposed-not-applied.</span>` : ''}
    <span>The authored text is stored in the downloaded proposal JSON. It is not inferred from image content, applied to the PDF, or validated for meaning. Text beginning like a filesystem path is rejected by the local sidecar safety policy.</span>
    <span>This local inspection is non-authoritative. Every candidate is proposed-not-applied; no tags or PDF bytes are changed, and this is not PDF/UA conformance validation.</span>
  </div>`;
}

export function incrementalAccessibilityMetadataResult(state) {
  const result = state.incrementalAccessibilityMetadataResult;
  if (!result) return '';
  return `<div class="comparison-result preflight-result" role="status">
    <strong>Verified language and title copy ready</strong>
    <span>${escapeHtml(result.artifact?.displayName ?? 'Derived PDF')} · downloaded as a separate append-only PDF</span>
    <span>The immutable source is unchanged. Historical metadata remains recoverable, and no tagging, structure repair, conformance certification, sanitization, or signature preservation is claimed.</span>
  </div>`;
}
