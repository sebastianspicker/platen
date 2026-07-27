import { icon } from './icons.js';
import { escapeHtml } from './shared.js';

export function previewModeLabel(mode) {
  return mode === 'controlled'
    ? 'Safe raster'
    : mode === 'reflow'
      ? 'Text reflow'
      : mode === 'split'
        ? 'Split preview'
        : 'Native PDF';
}

export function proofStrip(state, analysis) {
  const document = state.document;
  const pageCount = analysis.inspection?.pageCount ?? 0;
  const selectedPage = state.selectedPage ?? 1;
  const analysisLabel = analysis.status === 'loading'
    ? analysis.progress ?? 'Analyzing locally'
    : analysis.status === 'ready'
      ? 'Analysis ready'
      : analysis.status === 'error'
        ? 'Analysis unavailable'
        : 'Waiting for a document';
  return `<section class="proof-strip" aria-label="Local document proof">
    <div class="proof-item"><span class="proof-label">Source</span><strong>${document.isOpen ? 'Immutable · local' : 'No source open'}</strong></div>
    <div class="proof-item"><span class="proof-label">Analysis</span><strong>${escapeHtml(analysisLabel)}</strong></div>
    <div class="proof-item"><span class="proof-label">Page</span><strong>${document.isOpen ? `${escapeHtml(selectedPage)} / ${escapeHtml(pageCount || '—')}` : '—'}</strong></div>
    <div class="proof-item"><span class="proof-label">Preview</span><strong>${previewModeLabel(state.viewerMode)}</strong></div>
  </section>`;
}

export function previewPageControls(state, pageCount) {
  const page = state.selectedPage ?? 1;
  const hasPages = state.document?.isOpen === true && Number.isSafeInteger(pageCount) && pageCount > 0;
  const previous = hasPages && page > 1 ? page - 1 : null;
  const next = hasPages && page < pageCount ? page + 1 : null;
  const pageTarget = (target, direction, label, iconName) => `<button class="icon-button page-switch-button" data-page-direction="${direction}" ${target ? `data-page-number="${target}"` : 'disabled'} aria-label="${label}" title="${label}">${icon(iconName)}</button>`;
  return `<div class="page-switcher" role="group" aria-label="Page navigation">
    ${pageTarget(previous, 'previous', 'Show previous page', 'undo')}
    <span class="page-switch-label">Page <strong>${page}</strong> <span aria-hidden="true">/</span> ${hasPages ? pageCount : '—'}</span>
    ${pageTarget(next, 'next', 'Show next page', 'redo')}
  </div>`;
}
