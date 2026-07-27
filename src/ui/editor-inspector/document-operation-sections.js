import { escapeHtml } from '../shared.js';
import { comparisonResult } from '../editor-result-views.js';
import { rasterEditSections } from './raster-edit-sections.js';

export function documentOperationSections(state, analysis, readiness) {
  const { ready, rasterAvailable } = readiness;
  const scanAppendReady = ready
    && state.host?.status === 'ready'
    && state.host?.conversionReady === true
    && rasterAvailable;
  return `
      <section class="property-section page-transform-section">
        <h3>Derived page tools</h3>
        <div class="page-transform-grid" role="group" aria-label="Derived page operations">
          <button class="button" data-action="split-document" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>Split all</button>
          <button class="button" data-action="split-verified-outline" ${analysis.status === 'ready' && state.host?.pdfkitOutlineSplitReady && !state.busyAction ? '' : 'disabled'}>Split at verified top-level bookmarks (macOS)</button>
          <button class="button" data-action="duplicate-page" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>Duplicate selected</button>
          <button class="button" data-action="reverse-pages" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>Reverse all</button>
          <button class="button" data-action="choose-interleave-file" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>Interleave PDF…</button>
          <button class="button" data-action="choose-insert-file" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>Insert after selected…</button>
          <button class="button" data-action="choose-replace-file" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>Replace selected…</button>
          <button class="button" data-action="insert-blank-page" ${analysis.status === 'ready' && state.host?.conversionReady && !state.busyAction ? '' : 'disabled'}>Insert blank</button>
        </div>
        <div class="inline-rule-control">
          <label for="split-rule-pages">Pages per split file</label>
          <input id="split-rule-pages" type="number" min="1" max="500" step="1" value="${escapeHtml(state.splitRulePages ?? 10)}" />
          <button class="button" data-action="split-by-rule" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>Split by rule</button>
        </div>
        <div class="inline-rule-control">
          <label for="copy-source-page">Page in secondary PDF</label>
          <input id="copy-source-page" type="number" min="1" max="100" step="1" value="${escapeHtml(state.copySourcePage ?? 1)}" />
          <button class="button" data-action="choose-copy-page-file" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>Choose PDF and copy</button>
        </div>
        <div class="inline-rule-control">
          <button class="button" data-action="choose-scan-page-file" ${scanAppendReady ? '' : 'disabled'}>Choose scan and append as page</button>
        </div>
        <p class="field-help">Accepts one bounded PNG, JPEG, or TIFF image. It is converted locally to one page, appended after the selected page, and exported as a separate validated PDF; both sources remain unchanged.</p>
        <p class="field-help">The one-page copy accepts only two bounded, passive, unsigned PDFs. It verifies both immutable source digests and the exact output page order using page geometry, normalized extracted text, and fixed-resolution renders. It does not preserve document-level structures, signatures, object identity, or original bytes.</p>
        <p class="field-help">Every action creates a separately validated PDF and leaves all local source files unchanged. Individual-file split is bounded to 100 pages. The macOS bookmark split re-inspects the immutable source, accepts only 2–100 complete top-level local bookmarks with strictly increasing starts from page 1, and never uses bookmark titles in names or provenance.</p>
      </section>
      <section class="property-section export-section">
        <h3>Extracted-text export</h3>
        <label class="field-label" for="text-export-format">Local format</label>
        <select id="text-export-format" ${analysis.textPages.length ? '' : 'disabled'}>
          ${[['text', 'Plain text'], ['rtf', 'Rich Text Format'], ['html', 'Semantic HTML'], ['xml', 'Page XML']].map(([value, label]) => `<option value="${value}" ${state.textExportFormat === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <button class="button" data-action="export-structured-text" ${analysis.textPages.length ? '' : 'disabled'}>Export text structure</button>
        <p class="field-help">Exports locally extracted page text. It does not reconstruct the original layout, fonts, tables, or editable Office objects.</p>
      </section>
      ${rasterEditSections(state, readiness)}
      <section class="property-section comparison-section">
        <h3>Compare local PDFs</h3>
        <label class="field-label" for="comparison-mode">Comparison type</label>
        <select id="comparison-mode" ${ready ? '' : 'disabled'}>
          ${[['content', 'Extracted text'], ['pixel', 'Selected-page pixels'], ['annotations', 'Local annotations'], ['cross-format', 'Cross-format PDF content'], ['overlay', 'Overlay descriptor'], ['side-by-side', 'Side-by-side descriptor']].map(([value, label]) => `<option value="${value}" ${state.comparisonMode === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <button class="button" data-action="choose-comparison-file" ${ready ? '' : 'disabled'}>Choose comparison PDF…</button>
        <p class="field-help">Content, pixel, and local sidecar-annotation comparisons are computed locally. Overlay and side-by-side modes currently return review-layout descriptors, not rendered composite files.</p>
        ${comparisonResult(state)}
      </section>
      <section class="property-section page-transform-section">
        <h3>Optimize derived copy</h3>
        <div class="page-transform-grid" role="group" aria-label="Derived PDF rewrite operations">
          <button class="button" data-rewrite-mode="optimize" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>Compress</button>
          <button class="button" data-rewrite-mode="rewrite" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>Repair rewrite</button>
          <button class="button" data-rewrite-mode="flatten-transparency" ${analysis.status === 'ready' && !state.busyAction ? '' : 'disabled'}>Flatten transparency</button>
        </div>
        <p class="field-help">Ghostscript creates and validates a separate page-count-preserving PDF. The immutable source is never overwritten.</p>
      </section>`;
}
