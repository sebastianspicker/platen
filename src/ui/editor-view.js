import { icon } from './icons.js';
import { brandAndMenu, errorBanner, escapeHtml, rail } from './shared.js';
import { documentTabsView } from './document-tabs-view.js';
import {
  documentSurface,
  emptyAnalysis,
  inspector,
  pagesPanel,
  toolbar,
} from './editor-inspector/index.js';
import { previewPageControls, proofStrip } from './editor-proof-strip.js';
import { splitProofEditor } from './editor-split-view.js';

/**
 * Composes the editor shell from pure, state-sliced renderers. Event wiring
 * remains in the controller; this module only maps state to escaped markup.
 */
export function editorView(state) {
  const document = state.document;
  const controlsDisabled = document.isOpen ? '' : 'disabled';
  const analysis = state.analysis ?? emptyAnalysis;
  const status = state.busyAction
    ? state.busyAction
    : analysis.status === 'loading'
      ? analysis.progress ?? 'Analyzing locally…'
      : analysis.status === 'ready'
        ? `Local analysis ready · ${analysis.inspection?.pageCount ?? 0} page${analysis.inspection?.pageCount === 1 ? '' : 's'}`
        : document.isOpen ? 'Browser preview ready · local analysis unavailable' : 'Ready — no document open';
  const activeTabId = state.documentTabs?.activeTabId;
  const workspaceRelation = activeTabId
    ? ` aria-labelledby="document-tab-${escapeHtml(activeTabId)}"`
    : ' aria-label="Document workspace"';
  const frameClass = document.isOpen
    ? `paper-frame zoom-${Math.round(state.zoom * 10)} rotation-${state.rotation}`
    : 'paper-frame paper-frame-empty';
  if (document.isOpen && state.viewerMode === 'split' && analysis.status === 'ready') {
    return splitProofEditor(state, analysis, workspaceRelation);
  }
  return `<div class="app-shell ${state.presentationMode ? 'is-presentation' : ''}">
    ${brandAndMenu('editor', {
      context: document.isOpen ? document.name : 'No source open',
    })}
    ${toolbar(state)}
    <main class="workspace" id="workspace" role="tabpanel"${workspaceRelation} tabindex="-1">
      ${documentTabsView(state)}
      <div class="editor-layout">
        ${rail('editor')}
        ${pagesPanel(state)}
        <section class="document-stage ${state.dragging ? 'is-dragging' : ''} ${state.showGrid ? 'show-grid' : ''}" data-drop-zone aria-label="Document workspace">
          <div class="drop-overlay">Drop a local PDF to open it</div>
          ${analysis.status === 'loading' ? `<div class="processing-chip" role="status"><span class="spinner"></span>${escapeHtml(analysis.progress ?? 'Analyzing locally…')}</div>` : ''}
          ${proofStrip(state, analysis)}
          <div class="${frameClass}">
            ${documentSurface(document, state.selectedPage ?? 1, state)}
          </div>
          ${document.isOpen ? `<div class="document-controls" role="toolbar" aria-label="Preview controls">
            <button class="icon-button" data-action="zoom-out" ${controlsDisabled} aria-label="Zoom out">${icon('minus')}</button>
            <span class="control-label">${Math.round(state.zoom * 100)}% · Page ${state.selectedPage ?? 1}</span>
            <button class="icon-button" data-action="zoom-in" ${controlsDisabled} aria-label="Zoom in">${icon('plus')}</button>
            ${previewPageControls(state, analysis.inspection?.pageCount ?? 0)}
            <span class="toolbar-separator"></span>
            <button class="icon-button" data-action="rotate-preview" ${controlsDisabled} aria-label="Rotate preview clockwise">${icon('rotate')}</button>
            <button class="icon-button" data-action="history-back" ${state.navigationIndex > 0 ? '' : 'disabled'} aria-label="Go to previous viewed page">${icon('undo')}</button>
            <button class="icon-button" data-action="history-forward" ${state.navigationIndex < (state.navigationHistory?.length ?? 1) - 1 ? '' : 'disabled'} aria-label="Go to next viewed page">${icon('redo')}</button>
            <button class="icon-button" data-action="read-selected-page" ${analysis.textPages.length ? '' : 'disabled'} aria-label="Read selected page aloud">${icon('play')}</button>
            <button class="icon-button" data-action="fullscreen" ${controlsDisabled} aria-label="Enter fullscreen">${icon('fullscreen')}</button>
            <button class="icon-button" data-action="presentation-mode" ${controlsDisabled} aria-label="Toggle presentation mode">${icon('eye')}</button>
          </div>` : ''}
        </section>
        ${inspector(state)}
      </div>
    </main>
    <footer class="status-bar" role="status">
      <span class="status-dot ${analysis.status === 'error' || state.host?.status === 'unavailable' ? 'is-neutral' : ''}"></span>
      <span>${escapeHtml(status)}</span>
      ${state.canCancel ? '<button class="status-action" data-action="cancel-operation">Cancel operation</button>' : ''}
      <span class="status-spacer"></span>
      <button class="status-action" data-action="show-plugins">${icon('warning')} ${state.summary.planned} planned capabilities</button>
    </footer>
    ${errorBanner(state.error)}
    <input id="file-picker" class="sr-only" type="file" accept="application/pdf,.pdf" />
    <input id="merge-picker" class="sr-only" type="file" accept="application/pdf,.pdf" />
    <input id="interleave-picker" class="sr-only" type="file" accept="application/pdf,.pdf" />
    <input id="insert-picker" class="sr-only" type="file" accept="application/pdf,.pdf" />
    <input id="replace-picker" class="sr-only" type="file" accept="application/pdf,.pdf" />
    <input id="copy-page-picker" class="sr-only" type="file" accept="application/pdf,.pdf" />
    <input id="scan-append-picker" class="sr-only" type="file" accept=".png,.jpg,.jpeg,.tif,.tiff" />
    <input id="comparison-picker" class="sr-only" type="file" accept="application/pdf,.pdf" />
    <input id="conversion-picker" class="sr-only" type="file" accept=".png,.jpg,.jpeg,.tif,.tiff,.doc,.docx,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.rtf,.txt,.csv,.html,.htm,.ps,.eps,.dxf" />
    <input id="combine-picker" class="sr-only" type="file" multiple accept="application/pdf,.pdf,.png,.jpg,.jpeg,.tif,.tiff,.doc,.docx,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.rtf,.txt,.csv,.html,.htm,.ps,.eps,.dxf" />
  </div>`;
}
