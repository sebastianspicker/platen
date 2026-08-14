import { CONTROLLED_RASTER_MAX_EDGE } from '../../core/controlled-raster-session.js';
import {
  clipboardTextWritingAvailable,
  pageTextForClipboard,
} from '../../core/page-text-clipboard.js';
import { inspectViewerAnalysisBinding, isViewerAnalysisBound } from '../../core/viewer-analysis-binding.js';
import { isViewerDocumentBound } from '../../core/viewer-grid-overlay.js';
import { resolveViewerPageLayout } from '../../core/viewer-page-layout.js';
import { icon } from '../icons.js';
import { escapeHtml } from '../shared.js';

export const emptyAnalysis = Object.freeze({
  status: 'idle',
  documentId: null,
  progress: null,
  inspection: null,
  structure: null,
  textPages: [],
  thumbnails: [],
  thumbnailNotice: null,
  fonts: [],
  images: [],
  attachments: [],
  signatures: null,
});

export function toolbar(state) {
  const document = state.document;
  const analysis = state.analysis ?? emptyAnalysis;
  const disabled = document.isOpen ? '' : 'disabled';
  const engineDisabled = analysis.status === 'ready' ? '' : 'disabled';
  const sourceReadyDisabled = isViewerAnalysisBound(analysis) ? '' : 'disabled';
  const busyDisabled = state.busyAction ? 'disabled' : '';
  const pageOrder = state.pageOrder ?? [];
  const pageCount = analysis.inspection?.pageCount ?? 0;
  const arrangementChanged = pageOrder.length > 0 && (pageOrder.length !== pageCount || pageOrder.some((page, index) => page !== index + 1));
  return `
    <div class="toolbar" role="toolbar" aria-label="Document actions">
      <div class="toolbar-group toolbar-group-source" role="group" aria-label="Source">
        <button class="tool-button" data-action="open-file">${icon('folder')}<span class="toolbar-label">Open PDF</span></button>
        <button class="tool-button" data-action="choose-conversion-file" ${state.host?.conversionReady && !state.busyAction ? '' : 'disabled'} title="Convert a supported local file to PDF">
          ${icon('plus')}<span class="toolbar-label toolbar-label-compact">Convert</span>
        </button>
      </div>
      <div class="toolbar-group toolbar-group-output" role="group" aria-label="Source and output">
        <button class="tool-button" data-action="download-original" ${disabled} title="Download the unchanged source file">
          ${icon('save')}<span class="toolbar-label toolbar-label-compact">Original</span>
        </button>
        <button class="tool-button" data-action="print-document" ${disabled} title="Open the browser's local print dialog">
          ${icon('print')}<span class="toolbar-label toolbar-label-compact">Print</span>
        </button>
        <button class="tool-button" data-action="extract-page" ${engineDisabled || busyDisabled} title="Create a separate PDF containing the selected page">
          ${icon('export')}<span class="toolbar-label">Extract page</span>
        </button>
        <button class="tool-button" data-action="export-arrangement" ${arrangementChanged && !state.busyAction ? '' : 'disabled'} title="Create a derived PDF with the arranged page order">
          ${icon('pages')}<span class="toolbar-label toolbar-label-compact">Export arrangement</span>
        </button>
        <button class="tool-button secondary-tool" data-action="choose-merge-file" ${engineDisabled || busyDisabled} title="Append another local PDF into a derived PDF">
          ${icon('plus')}<span class="toolbar-label toolbar-label-compact">Merge</span>
        </button>
        <button class="tool-button secondary-tool" data-action="export-page-image" ${engineDisabled || busyDisabled} title="Render the selected page as PNG">
          ${icon('image')}<span class="toolbar-label toolbar-label-compact">PNG</span>
        </button>
        <button class="tool-button secondary-tool" data-action="export-text" ${engineDisabled} title="Export locally extracted text">
          ${icon('file')}<span class="toolbar-label toolbar-label-compact">Text</span>
        </button>
      </div>
      <div class="toolbar-group toolbar-group-view" role="group" aria-label="View">
        <button class="tool-button ${state.viewerMode === 'reflow' ? 'is-selected' : ''}" data-action="toggle-reflow" aria-pressed="${state.viewerMode === 'reflow'}" ${sourceReadyDisabled} title="Show a source-bound extracted-text reflow view">
          ${icon('file')}<span class="toolbar-label toolbar-label-compact">Reflow</span>
        </button>
        <button class="tool-button ${state.viewerMode === 'split' ? 'is-selected' : ''}" data-action="toggle-split-view" aria-pressed="${state.viewerMode === 'split'}" ${sourceReadyDisabled} title="Compare the native PDF with source-bound extracted text">
          ${icon('layers')}<span class="toolbar-label toolbar-label-compact">Split</span>
        </button>
        <button class="tool-button ${state.viewerMode === 'controlled' ? 'is-selected' : ''}" data-action="toggle-controlled-render" aria-pressed="${state.viewerMode === 'controlled'}" ${engineDisabled} title="Render the selected page as a passive local Poppler image">
          ${icon('image')}<span class="toolbar-label toolbar-label-compact">Safe raster</span>
        </button>
        <button class="tool-button" data-action="cycle-page-layout" ${sourceReadyDisabled} aria-label="Cycle page layout; current layout ${escapeHtml(state.viewerPageLayout ?? 'single')}" title="Cycle single, continuous, facing, and cover-facing layouts">
          ${icon('pages')}<span class="toolbar-label toolbar-label-compact">Layout</span>
        </button>
        <button class="tool-button ${state.showGrid ? 'is-selected' : ''}" data-action="toggle-grid" aria-pressed="${state.showGrid === true}" ${sourceReadyDisabled} title="Toggle a local grid overlay">
          ${icon('grid')}<span class="toolbar-label toolbar-label-compact">Grid</span>
        </button>
      </div>
      <label class="search-control" title="Search text extracted by the local Poppler engine">
        ${icon('search')}<span class="sr-only">Search document text</span>
        <input id="document-search" type="search" placeholder="Search this PDF" value="${escapeHtml(state.searchQuery ?? '')}" ${analysis.textPages.length ? '' : 'disabled'} />
      </label>
    </div>`;
}

function placeholderPaper(state) {
  const conversionReady = state.host?.conversionReady && !state.busyAction;
  return `<article class="paper empty-paper" aria-label="No PDF open">
    <div class="empty-paper-copy">
      <h1>Open a local PDF to inspect it</h1>
      <p>Choose a file from this device. The original bytes stay immutable while local engines prepare page, text, and resource evidence.</p>
    </div>
    <div class="empty-actions" role="group" aria-label="Start a document">
      <button class="button primary" data-action="open-file">${icon('folder')}Open PDF</button>
      <button class="button" data-action="create-blank-document" ${conversionReady ? '' : 'disabled'}>Create blank</button>
      <button class="button" data-action="choose-conversion-file" ${conversionReady ? '' : 'disabled'}>Convert a file</button>
    </div>
    <dl class="empty-facts">
      <div><dt>Source</dt><dd>Immutable local copy</dd></div>
      <div><dt>Analysis</dt><dd>Poppler text, pages, fonts, images</dd></div>
      <div><dt>Boundary</dt><dd>Token-authenticated loopback host</dd></div>
    </dl>
  </article>`;
}

function nativePdf(document, page, className = '', toolbarVisible = true) {
  const source = escapeHtml(`${document.objectUrl}#page=${page}&toolbar=${toolbarVisible ? '1' : '0'}&navpanes=0`);
  return `<object class="native-pdf${className ? ` ${className}` : ''}" data="${source}" type="application/pdf" aria-label="PDF preview for ${escapeHtml(document.name)}, page ${page}">
    <div class="viewer-fallback">
      <h2>Native PDF preview is unavailable</h2>
      <p>This browser did not render the local PDF. Local inspection and unchanged download remain available.</p>
      <button class="button primary" data-action="download-original">Download original</button>
    </div>
  </object>`;
}

function highlightedText(text, query) {
  if (!query) return escapeHtml(text || 'No extractable text on this page.');
  const source = String(text || 'No extractable text on this page.');
  const index = source.toLocaleLowerCase('en-US').indexOf(String(query).toLocaleLowerCase('en-US'));
  if (index < 0) return escapeHtml(source);
  const end = index + String(query).length;
  return `${escapeHtml(source.slice(0, index))}<mark>${escapeHtml(source.slice(index, end))}</mark>${escapeHtml(source.slice(end))}`;
}

function splitReflowSurface(state, page) {
  const pageText = (state.analysis?.textPages ?? []).find((item) => item.page === page)?.text ?? '';
  return `<article class="split-reflow-view" aria-label="Extracted text reflow for page ${page}">
    <div class="split-reflow-kicker">Page ${page} · extracted locally</div>
    <h2>Text reflow</h2>
    <p>${highlightedText(pageText, state.searchQuery)}</p>
  </article>`;
}

function controlledRasterSurface(state, page) {
  const preview = state.controlledRaster ?? {};
  if (preview.status === 'ready' && preview.page === page && preview.url) {
    return `<figure class="controlled-raster-view" aria-label="Passive local raster preview for page ${page}">
      <img src="${escapeHtml(preview.url)}" alt="Passive Poppler raster rendering of page ${page}" width="1000" height="1414" loading="lazy" decoding="async" draggable="false" />
      <figcaption>Passive local Poppler render · bounded ${CONTROLLED_RASTER_MAX_EDGE.toLocaleString('en-US')} px longest edge · PDF actions disabled · no selectable text</figcaption>
    </figure>`;
  }
  if (preview.status === 'error' && preview.page === page) {
    return `<div class="controlled-raster-state">
      <h2>Safe raster preview failed</h2>
      <p role="alert">${escapeHtml(preview.error ?? 'Local page rendering failed.')}</p>
      <div class="button-row"><button class="button primary" data-action="retry-controlled-render">Retry local render</button><button class="button" data-action="toggle-controlled-render">Use native preview</button></div>
    </div>`;
  }
  return `<div class="controlled-raster-state" role="status"><span class="spinner"></span><span>Rendering page ${page} as a passive local image…</span></div>`;
}

function pageLayoutSurface(document, selectedPage, state, binding) {
  let resolved;
  try {
    resolved = resolveViewerPageLayout({
      layout: state.viewerPageLayout ?? 'single',
      selectedPage,
      pageCount: binding.pageCount,
    });
  } catch {
    return nativePdf(document, selectedPage);
  }
  if (resolved.layout === 'single') return nativePdf(document, selectedPage);
  const pages = resolved.pages.map((page) => `<article class="page-layout-item" aria-label="Page ${page}">
    ${nativePdf(document, page, 'layout-native-pdf', false)}
  </article>`).join('');
  const notice = resolved.truncated
    ? '<p class="page-layout-notice" role="status">Continuous view is bounded to the first 32 pages. Select another page to inspect it directly.</p>'
    : '';
  return `<section class="page-layout-view layout-${resolved.layout}" aria-label="${escapeHtml(resolved.layout)} page layout">
    ${pages}${notice}
  </section>`;
}

export function documentSurface(document, selectedPage, state) {
  if (!document.isOpen) return placeholderPaper(state);
  if (!isViewerDocumentBound(document)) {
    return `<div class="viewer-fallback" role="alert">
      <h2>Local PDF preview is unavailable</h2>
      <p>The viewer rejected a source that was not bound to a local document URL.</p>
    </div>`;
  }
  const page = Number.isInteger(selectedPage) ? selectedPage : 1;
  const binding = inspectViewerAnalysisBinding(state.analysis);
  if (state.viewerMode === 'reflow') {
    if (!binding.ready) return nativePdf(document, page);
    return `<article class="reflow-view" aria-label="Extracted text reflow view">
      ${(state.analysis?.textPages ?? []).map((item) => `<section id="reflow-page-${item.page}"><h2>Page ${item.page}</h2><p>${escapeHtml(item.text || 'No extractable text on this page.')}</p></section>`).join('')}
    </article>`;
  }
  if (state.viewerMode === 'split') {
    const reportedPageCount = binding.ready ? binding.pageCount : 0;
    if (!Number.isSafeInteger(reportedPageCount) || reportedPageCount < 1) {
      return nativePdf(document, page);
    }
    const selectedPage = Math.min(page, reportedPageCount);
    return `<div class="split-preview" aria-label="Native PDF and extracted text split preview">
      <section class="split-pane split-pane-native">
        <header class="split-pane-bar">
          <button type="button" data-action="toggle-split-view" aria-pressed="true">Source</button>
          <span class="pane-meta">Immutable</span>
        </header>
        <div class="split-source-pane">${nativePdf(document, selectedPage, 'split-native-pdf', false)}</div>
      </section>
      <section class="split-pane split-pane-reflow">
        <header class="split-pane-bar">
          <button type="button" data-action="toggle-reflow" aria-pressed="false">Text reflow</button>
          <span class="pane-meta">Source-bound · read-only</span>
        </header>
        ${splitReflowSurface(state, selectedPage)}
      </section>
    </div>`;
  }
  if (state.viewerMode === 'controlled') return controlledRasterSurface(state, page);
  return binding.ready ? pageLayoutSurface(document, page, state, binding) : nativePdf(document, page);
}

function thumbnailList(analysis, selectedPage, pageOrder) {
  if (analysis.status === 'loading') {
    return `<div class="analysis-loading" role="status"><span class="spinner"></span><span>${escapeHtml(analysis.progress ?? 'Inspecting locally…')}</span></div>`;
  }
  if (!analysis.thumbnails.length) {
    return `<p class="thumbnail-note">${analysis.thumbnailNotice
      ? escapeHtml(analysis.thumbnailNotice)
      : analysis.status === 'error'
      ? 'Local page analysis is unavailable. The browser preview still uses your original file.'
      : 'Open a PDF to generate real local thumbnails.'}</p>`;
  }
  const byPage = new Map(analysis.thumbnails.map((thumbnail) => [thumbnail.page, thumbnail]));
  const ordered = (pageOrder?.length ? pageOrder : analysis.thumbnails.map(({ page }) => page))
    .map((page) => byPage.get(page))
    .filter(Boolean);
  return ordered.map(({ page, url }) => `
    <button class="page-thumbnail-button ${page === selectedPage ? 'is-selected' : ''}" data-page-number="${page}" aria-label="Show page ${page}" aria-current="${page === selectedPage ? 'page' : 'false'}">
      <img class="page-thumbnail-image" src="${escapeHtml(url)}" width="120" height="170" loading="lazy" decoding="async" alt="Thumbnail of page ${page}" />
      <span>Page ${page}</span>
    </button>`).join('');
}

function searchResults(state) {
  const results = state.searchResults ?? [];
  if (!state.searchQuery) return '';
  if (!results.length) return `<div class="search-empty">No extracted-text matches for “${escapeHtml(state.searchQuery)}”.</div>`;
  return `<div class="search-results" aria-label="Document search results">
    ${results.map((result) => `<button class="search-result" data-page-number="${result.page}">
      <strong>Page ${result.page}</strong>
      <span>${escapeHtml(result.before)}<mark>${escapeHtml(result.match)}</mark>${escapeHtml(result.after)}</span>
    </button>`).join('')}
  </div>`;
}

export function pagesPanel(state) {
  const analysis = state.analysis ?? emptyAnalysis;
  const count = analysis.inspection?.pageCount;
  const pageTextReady = analysis.status === 'ready' && Boolean(analysis.documentId)
    && !state.busyAction
    && Boolean(pageTextForClipboard(analysis.textPages, state.selectedPage))
    && clipboardTextWritingAvailable();
  return `<aside class="pages-panel" aria-label="Pages panel">
    <div class="panel-header"><span>${state.searchQuery ? 'Search' : 'Pages'}</span><span class="muted-count">${count ? `${count} page${count === 1 ? '' : 's'}` : state.document.isOpen ? 'Analyzing' : 'No file'}</span></div>
    <div class="panel-content">
      <button class="button" data-action="copy-page-text" title="Copy bounded extracted text from the current physical page" ${pageTextReady ? '' : 'disabled'}>Copy page text</button>
      ${analysis.textPages.length ? `<div class="advanced-search-options" aria-label="Advanced search options">
        <label><input id="search-case-sensitive" type="checkbox" ${state.searchCaseSensitive ? 'checked' : ''} /> Match case</label>
        <label><input id="search-whole-word" type="checkbox" ${state.searchWholeWord ? 'checked' : ''} /> Whole words</label>
      </div>` : ''}
      ${state.searchQuery ? searchResults(state) : `<div class="thumbnail-list">${thumbnailList(analysis, state.selectedPage ?? 1, state.pageOrder)}</div>`}
      ${!state.searchQuery && analysis.status === 'ready' ? `<div class="page-arrange-controls" role="toolbar" aria-label="Arrange selected page">
        <button class="icon-button" data-action="move-page-back" title="Move selected page earlier" aria-label="Move selected page earlier">${icon('undo')}</button>
        <button class="icon-button" data-action="move-page-forward" title="Move selected page later" aria-label="Move selected page later">${icon('redo')}</button>
        <button class="icon-button danger" data-action="remove-page" title="Remove selected page from the derived arrangement" aria-label="Remove selected page from arrangement">${icon('trash')}</button>
        <button class="button" data-action="restore-page-order">Reset</button>
      </div>` : ''}
      ${count > analysis.thumbnails.length ? `<p class="thumbnail-note">Showing the first ${analysis.thumbnails.length} of ${count} pages to keep local rendering bounded.</p>` : ''}
      ${analysis.thumbnailNotice && analysis.thumbnails.length ? `<p class="thumbnail-note">${escapeHtml(analysis.thumbnailNotice)}</p>` : ''}
    </div>
  </aside>`;
}
