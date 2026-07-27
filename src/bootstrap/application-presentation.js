import { structuredTextExport, textExport } from '../core/document-analysis.js';
import { editorView } from '../ui/editor-view.js';
import { pluginsView } from '../ui/plugins-view.js';
import { trustView } from '../ui/trust-view.js';
import { workflowsView } from '../ui/workflows-view.js';

const FOCUS_DATA_KEYS = Object.freeze([
  'action', 'tabId', 'domainGroup', 'domainOperation', 'pageDirection', 'pageNumber',
  'pluginRow', 'family', 'rasterOperation', 'rewriteMode',
]);
const FOCUS_CANDIDATE_SELECTOR = [
  '[id]', '[data-action]', '[data-tab-id]', '[data-domain-group]',
  '[data-domain-operation]', '[data-page-direction]', '[data-page-number]', '[data-plugin-row]',
  '[data-family]', '[data-raster-operation]', '[data-rewrite-mode]',
].join(', ');

function focusIdentity(node) {
  if (node.dataset?.pageDirection) return { pageDirection: node.dataset.pageDirection };
  return Object.fromEntries(FOCUS_DATA_KEYS
    .filter((key) => node.dataset?.[key] !== undefined)
    .map((key) => [key, node.dataset[key]]));
}

function sameFocusIdentity(node, identity) {
  const entries = Object.entries(identity);
  return entries.length > 0 && entries.every(([key, value]) => node.dataset?.[key] === value);
}

function focusCandidates(root) {
  return [...(root.querySelectorAll?.(FOCUS_CANDIDATE_SELECTOR) ?? [])];
}

function isVisibleTextControl(node) {
  const isTextControl = node.matches?.('textarea, input:not([type="file"]):not([type="hidden"])');
  return Boolean(isTextControl && !node.hidden && node.getClientRects?.().length);
}

function captureFocus(root) {
  const documentApi = root?.ownerDocument ?? globalThis.document;
  const active = documentApi?.activeElement;
  if (!active || !root?.contains?.(active)) return null;
  if (active.id === 'file-picker') return { transientFilePicker: true };
  const identity = focusIdentity(active);
  const matching = focusCandidates(root).filter((node) => sameFocusIdentity(node, identity));
  const preserveCaret = isVisibleTextControl(active);
  return {
    id: active.id || null,
    identity,
    identityIndex: Math.max(0, matching.indexOf(active)),
    path: childIndexPath(root, active),
    selectionStart: preserveCaret && typeof active.selectionStart === 'number' ? active.selectionStart : null,
    selectionEnd: preserveCaret && typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
  };
}

function childIndexPath(root, node) {
  const path = [];
  let current = node;
  for (; current && current !== root; current = current.parentElement) {
    const siblings = [...(current.parentElement?.children ?? [])];
    const index = siblings.indexOf(current);
    if (index < 0) return null;
    path.unshift(index);
  }
  return current === root ? path : null;
}

function nodeAtPath(root, path) {
  if (!path) return null;
  return path.reduce((node, index) => node?.children?.[index] ?? null, root);
}

function captureScroll(root) {
  const nodes = [root, ...(root.querySelectorAll?.('[id], [class]') ?? [])];
  return nodes
    .filter((node) => node && (node.scrollTop || node.scrollLeft))
    .map((node) => ({
      id: node === root ? null : node.id || null,
      path: childIndexPath(root, node),
      scrollTop: node.scrollTop,
      scrollLeft: node.scrollLeft,
    }));
}

function restoreScroll(root, snapshot) {
  for (const entry of snapshot) {
    let target = entry.id ? root.querySelector?.(`#${entry.id}`) : null;
    if (!target) target = nodeAtPath(root, entry.path);
    if (!target) continue;
    target.scrollTop = entry.scrollTop;
    target.scrollLeft = entry.scrollLeft;
  }
}

function restoreFocus(root, snapshot) {
  if (!snapshot) return false;
  if (snapshot.transientFilePicker) {
    const destination = root.querySelector?.('[role="tab"][aria-selected="true"]')
      ?? root.querySelector?.('#workspace');
    destination?.focus?.({ preventScroll: true });
    return Boolean(destination);
  }
  const candidates = focusCandidates(root);
  const matching = candidates.filter((node) => sameFocusIdentity(node, snapshot.identity));
  const canFocus = (node) => node && typeof node.focus === 'function'
    && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true';
  const primary = [
    candidates.find((node) => snapshot.id && node.id === snapshot.id),
    matching[snapshot.identityIndex],
    nodeAtPath(root, snapshot.path),
  ];
  let target = primary.find(canFocus);
  if (!target && snapshot.identity?.pageDirection) {
    target = candidates.find((node) => node.dataset?.pageDirection
      && node.dataset.pageDirection !== snapshot.identity.pageDirection && canFocus(node));
  }
  if (!target) return false;
  target.focus({ preventScroll: true });
  if (snapshot.selectionStart !== null && typeof target.setSelectionRange === 'function') {
    target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd ?? snapshot.selectionStart);
  }
  return true;
}

export function createApplicationPresentation({ root, liveRegion, state, session }) {
  let renderedView = null;
  let focusErrorOnNextRender = false;

  function announce(message) {
    liveRegion.textContent = '';
    const schedule = globalThis.requestAnimationFrame ?? ((callback) => globalThis.setTimeout(callback, 0));
    schedule(() => { liveRegion.textContent = message; });
  }

  function render() {
    if (!state.registry) return;
    const snapshot = captureFocus(root);
    const scroll = captureScroll(root);
    const viewChanged = renderedView !== null && renderedView !== state.view;
    const hadError = Boolean(state.error);
    root.setAttribute('aria-busy', 'true');
    root.innerHTML = state.view === 'plugins'
      ? pluginsView(state)
      : state.view === 'workflows'
        ? workflowsView(state)
        : state.view === 'trust'
          ? trustView(state)
          : editorView(state);
    root.setAttribute('aria-busy', 'false');
    renderedView = state.view;
    if (!viewChanged) restoreScroll(root, scroll);
    if (focusErrorOnNextRender || (state.error && !hadError)) {
      root.querySelector?.('[data-action="dismiss-error"]')?.focus({ preventScroll: true });
      focusErrorOnNextRender = false;
    } else if (viewChanged) {
      root.querySelector?.('#workspace')?.focus({ preventScroll: true });
    } else if (!restoreFocus(root, snapshot)) {
      root.querySelector?.('#workspace')?.focus({ preventScroll: true });
    }
  }

  function showError(error) {
    state.error = error?.message || String(error);
    focusErrorOnNextRender = true;
    announce(state.error);
    render();
  }

  function triggerDownload({ blob, url, fileName, message }) {
    const objectUrl = url ?? URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    if (!url) setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    announce(message);
  }

  function downloadOriginal() {
    try {
      const file = session.getOriginal();
      triggerDownload({
        url: state.document.objectUrl,
        fileName: file.name || 'document.pdf',
        message: 'Downloading the unchanged original PDF.',
      });
    } catch (error) {
      showError(error);
    }
  }

  function exportText() {
    if (!state.analysis.textPages.length) return;
    const stem = (state.document.name || 'document').replace(/\.pdf$/i, '');
    const blob = new Blob([textExport(state.analysis.textPages)], { type: 'text/plain;charset=utf-8' });
    triggerDownload({ blob, fileName: `${stem}.txt`, message: 'Exporting locally extracted text.' });
  }

  function exportStructuredText() {
    if (!state.analysis.textPages.length) return;
    try {
      const stem = (state.document.name || 'document').replace(/\.pdf$/i, '');
      const output = structuredTextExport(state.analysis.textPages, state.textExportFormat, { title: state.document.name || 'PDF text export' });
      const blob = new Blob([output.data], { type: output.mediaType });
      triggerDownload({ blob, fileName: `${stem}.${output.extension}`, message: `Extracted page text exported locally as ${output.extension.toUpperCase()}.` });
    } catch (error) {
      showError(error);
    }
  }

  return Object.freeze({
    announce,
    render,
    showError,
    triggerDownload,
    downloadOriginal,
    exportText,
    exportStructuredText,
  });
}
