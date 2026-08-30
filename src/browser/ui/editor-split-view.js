import { icon } from './icons.js';
import { errorBanner, escapeHtml, rail } from './shared.js';
import { documentSurface } from './editor-inspector/index.js';
import { previewPageControls } from './editor-proof-strip.js';

function truncateDigest(value) {
  const digest = typeof value === 'string' ? value : '';
  if (!/^[a-f0-9]{16,}$/iu.test(digest)) return null;
  return `${digest.slice(0, 4).toUpperCase()}…${digest.slice(-4).toUpperCase()}`;
}

export function splitProofBar(state, analysis) {
  const page = state.selectedPage ?? 1;
  const count = analysis.inspection?.pageCount ?? 0;
  const resultCount = state.searchResults?.length ?? 0;
  const sourceName = state.document?.name || 'Open document';
  return `<header class="studio-app-bar split-proof-bar">
    <div class="studio-brand">
      <span class="brand-wordmark">Platen<span>The local-first PDF workbench.</span></span>
    </div>
    <span class="studio-document-name" title="${escapeHtml(sourceName)}">${escapeHtml(sourceName)}</span>
    <div class="studio-page-context">
      <span>Page ${escapeHtml(page)} of ${escapeHtml(count || '—')}</span>
      ${previewPageControls(state, count)}
    </div>
    <label class="split-proof-search search-control" title="Search text extracted by the local Poppler engine">
      ${icon('search')}<span class="sr-only">Search document text</span>
      <input id="document-search" type="search" placeholder="Search this PDF" value="${escapeHtml(state.searchQuery ?? '')}" ${analysis.textPages.length ? '' : 'disabled'} />
    </label>
    <span class="split-result-count" aria-live="polite">${resultCount} result${resultCount === 1 ? '' : 's'}</span>
    <button class="button studio-open-action" type="button" data-action="open-file">${icon('folder')}Open PDF</button>
  </header>`;
}

export function splitPagesRail(state, analysis) {
  const selectedPage = state.selectedPage ?? 1;
  const thumbnails = analysis.thumbnails ?? [];
  const count = analysis.inspection?.pageCount ?? thumbnails.length;
  const items = thumbnails.length
    ? thumbnails.map(({ page, url }) => `<button class="split-thumbnail ${page === selectedPage ? 'is-selected' : ''}" data-page-number="${page}" aria-label="Show page ${page}" aria-current="${page === selectedPage ? 'page' : 'false'}">
        <img src="${escapeHtml(url)}" width="86" height="118" loading="lazy" decoding="async" alt="Thumbnail of page ${page}" />
        <span>${page}</span>
      </button>`).join('')
    : `<p class="split-thumbnail-empty">${analysis.status === 'loading' ? 'Analyzing pages…' : 'No thumbnails available'}</p>`;
  return `<aside class="split-pages-rail" aria-label="Pages">
    <div class="split-pages-heading"><span>Pages</span><b>${escapeHtml(count || 0)}</b></div>
    <div class="split-pages-list">${items}</div>
  </aside>`;
}

function evidenceState(label, value) {
  return `<div class="evidence-row"><span><strong>${label}</strong><small>${escapeHtml(value)}</small></span><span class="evidence-ok">OK</span></div>`;
}

export function inspectionEvidence(state, analysis) {
  const results = state.searchResults ?? [];
  const query = state.searchQuery ?? '';
  const tagged = analysis.inspection?.tagged === true ? 'Present' : 'Coverage known';
  return `<aside class="inspection-evidence" aria-label="Inspection evidence">
    <header class="evidence-tabs" role="tablist" aria-label="Inspector">
      <button type="button" role="tab" aria-selected="true">Evidence</button>
      <button type="button" role="tab" aria-selected="false" data-action="show-workflows">Operations</button>
    </header>
    <div class="evidence-summary">
      ${evidenceState('Reading order', tagged)}
      ${evidenceState('Fonts', `${analysis.fonts?.length ?? 0} inspected`)}
      ${evidenceState('Images', `${analysis.images?.length ?? 0}`)}
      ${evidenceState('Tags', tagged)}
    </div>
    <section class="evidence-matches" aria-label="Search matches">
      <div class="evidence-section-heading"><h3>Search · ${results.length}</h3></div>
      ${query && results.length ? results.slice(0, 3).map((result, index) => `<button class="evidence-match ${index === 0 ? 'is-selected' : ''}" data-page-number="${result.page}">
        <span>${index + 1}</span>
        <span class="evidence-match-body"><strong>Page ${result.page}</strong>
        <small>${escapeHtml(result.before)}<mark>${escapeHtml(result.match)}</mark>${escapeHtml(result.after)}</small></span>
      </button>`).join('') : '<p class="evidence-empty">No active search matches.</p>'}
    </section>
    <button class="evidence-export" type="button" data-action="export-structured-text">Export evidence</button>
    <p class="evidence-foot-note">Creates a separate artifact. The source file is not modified.</p>
  </aside>`;
}

export function splitStatusBar(state, analysis) {
  const digest = truncateDigest(analysis.sha256);
  const sourceCrumb = digest
    ? `<span class="crumb"><b>Source</b> <code>${escapeHtml(digest)}</code></span>`
    : '<span class="crumb"><b>Source</b></span>';
  const inspectionCrumb = analysis.status === 'loading'
    ? `<span class="crumb">${escapeHtml(analysis.progress ?? 'Local inspection in progress')}</span>`
    : analysis.status === 'error'
      ? '<span class="crumb">Local inspection unavailable</span>'
      : analysis.status === 'ready'
        ? '<span class="crumb">Local inspection complete</span>'
        : '<span class="crumb">Waiting for inspection</span>';
  const outputCrumb = state.busyAction
    ? `<span class="crumb">${escapeHtml(state.busyAction)}</span>`
    : '<span class="crumb">No derived output</span>';
  return `<footer class="split-status-bar" role="status">
    <div class="status-crumbs">
      ${sourceCrumb}
      ${inspectionCrumb}
      ${outputCrumb}
    </div>
    <span class="provenance-source-state">Source unchanged</span>
    ${state.canCancel ? '<button class="status-action" data-action="cancel-operation">Cancel operation</button>' : ''}
  </footer>`;
}

export function splitProofEditor(state, analysis, workspaceRelation) {
  const document = state.document;
  return `<div class="app-shell is-split-proof ${state.presentationMode ? 'is-presentation' : ''}">
    ${splitProofBar(state, analysis)}
    <main class="workspace split-proof-workspace" id="workspace" role="tabpanel"${workspaceRelation} tabindex="-1">
      <div class="split-proof-layout">
        ${rail('editor')}
        ${splitPagesRail(state, analysis)}
        <section class="split-proof-stage ${state.dragging ? 'is-dragging' : ''}" data-drop-zone aria-label="Document comparison workspace">
          <div class="drop-overlay">Drop a local PDF to open it</div>
          ${documentSurface(document, state.selectedPage ?? 1, state)}
        </section>
        ${inspectionEvidence(state, analysis)}
      </div>
    </main>
    ${splitStatusBar(state, analysis)}
    ${errorBanner(state.error)}
    <input id="file-picker" class="sr-only" type="file" accept="application/pdf,.pdf" />
  </div>`;
}
