import { PlatenError } from './errors.js';
import { hasPdfHeader, isPdfCandidate, MAX_LOCAL_PDF_BYTES } from './document-session.js';

export const MAX_DOCUMENT_TABS = 8;

const DEFAULT_VIEWER_STATE = Object.freeze({
  zoom: 1,
  rotation: 0,
  selectedPage: 1,
  viewerMode: 'native',
  searchQuery: '',
  searchResults: [],
  navigationHistory: [1],
  navigationIndex: 0,
  controlledRaster: { status: 'idle', page: null, url: null, error: null },
  loupeRaster: { status: 'idle', page: null, url: null, error: null },
});

function cloneViewerState(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_VIEWER_STATE,
    ...source,
    searchResults: Array.isArray(source.searchResults) ? [...source.searchResults] : [],
    navigationHistory: Array.isArray(source.navigationHistory) && source.navigationHistory.length
      ? [...source.navigationHistory]
      : [1],
    controlledRaster: { ...DEFAULT_VIEWER_STATE.controlledRaster, ...(source.controlledRaster ?? {}) },
    loupeRaster: { ...DEFAULT_VIEWER_STATE.loupeRaster, ...(source.loupeRaster ?? {}) },
  };
}

function snapshotTab(tab) {
  return Object.freeze({
    id: tab.id,
    file: tab.file,
    name: tab.name,
    size: tab.size,
    type: tab.type,
    objectUrl: tab.objectUrl,
    status: tab.status,
    error: tab.error,
    analysis: tab.analysis,
    viewerState: Object.freeze(cloneViewerState(tab.viewerState)),
  });
}

function snapshot(store) {
  return Object.freeze({
    activeTabId: store.activeTabId,
    maxTabs: store.maxTabs,
    tabs: Object.freeze(store.tabs.map(snapshotTab)),
  });
}

function assertUrlApi(urlApi) {
  if (!urlApi || typeof urlApi.createObjectURL !== 'function' || typeof urlApi.revokeObjectURL !== 'function') {
    throw new PlatenError('URL_API_UNAVAILABLE', 'This browser cannot create local PDF preview URLs.');
  }
}

function makeId(idFactory, sequence) {
  const id = idFactory(sequence);
  if (typeof id !== 'string' || !id || id.length > 128) {
    throw new TypeError('Document tab id factory must return a bounded non-empty string.');
  }
  return id;
}

function ensureLive(store) {
  if (store.disposed) throw new PlatenError('TABS_DISPOSED', 'Document tabs are no longer available.');
}

function findTab(store, id) {
  return store.tabs.find((tab) => tab.id === id) ?? null;
}

function emit(store) {
  const state = snapshot(store);
  for (const listener of store.listeners) listener(state);
}

function revokeTab(tab, urlApi) {
  if (!tab?.objectUrl || tab.urlRevoked) return;
  tab.urlRevoked = true;
  urlApi.revokeObjectURL(tab.objectUrl);
}

function updateTab(store, id, patch = {}) {
  const tab = findTab(store, id);
  if (!tab) return false;
  if (Object.hasOwn(patch, 'viewerState')) tab.viewerState = cloneViewerState(patch.viewerState);
  if (Object.hasOwn(patch, 'analysis')) tab.analysis = patch.analysis;
  if (Object.hasOwn(patch, 'status')) tab.status = patch.status;
  if (Object.hasOwn(patch, 'error')) tab.error = patch.error;
  emit(store);
  return true;
}

async function openTab(store, config, file, { load } = {}) {
  ensureLive(store);
  if (store.tabs.length + store.pending >= store.maxTabs) throw new PlatenError('MAX_DOCUMENT_TABS', `You can keep at most ${store.maxTabs} local PDFs open.`);
  store.pending += 1;
  try {
    if (!isPdfCandidate(file)) throw new PlatenError('NOT_A_PDF', 'Choose a PDF file.');
    if (Number(file.size) === 0) throw new PlatenError('EMPTY_FILE', 'The selected PDF is empty.');
    if (Number(file.size) > MAX_LOCAL_PDF_BYTES) throw new PlatenError('FILE_TOO_LARGE', 'The selected PDF exceeds the 512 MB local preview limit.');
    if (!(await hasPdfHeader(file))) throw new PlatenError('INVALID_PDF_HEADER', 'The selected file does not contain a PDF header in its first 1,024 bytes.');
    ensureLive(store);
  } finally {
    store.pending -= 1;
  }
  const id = makeId(config.idFactory, ++store.sequence);
  if (findTab(store, id)) throw new PlatenError('TAB_ID_COLLISION', 'The local document tab identity was already allocated.');
  const tab = {
    id, file,
    name: typeof file.name === 'string' && file.name.trim() ? file.name.trim() : 'local-document.pdf',
    size: Number(file.size) || 0, type: file.type || 'application/pdf',
    objectUrl: config.urlApi.createObjectURL(file), urlRevoked: false,
    status: typeof load === 'function' ? 'loading' : 'ready', error: null, analysis: null,
    viewerState: cloneViewerState(),
  };
  const requestId = ++store.requestSequence;
  tab.requestId = requestId;
  store.tabs.push(tab); store.activeTabId = tab.id; emit(store);
  if (typeof load !== 'function') return snapshotTab(tab);
  const controller = new AbortController(); tab.controller = controller;
  try {
    const result = await load(file, { signal: controller.signal, tabId: tab.id });
    if (store.disposed || tab.requestId !== requestId || !findTab(store, tab.id)) return snapshotTab(tab);
    tab.analysis = result?.analysis ?? result ?? null; tab.status = 'ready'; tab.error = null; emit(store);
  } catch (error) {
    if (store.disposed || tab.requestId !== requestId || !findTab(store, tab.id) || error?.name === 'AbortError') return snapshotTab(tab);
    tab.status = 'error'; tab.error = error?.message || String(error); emit(store);
  } finally {
    if (tab.controller === controller) tab.controller = null;
  }
  return snapshotTab(tab);
}

function activateTab(store, id) {
  ensureLive(store);
  const tab = findTab(store, id);
  if (!tab) return false;
  store.activeTabId = id; emit(store); return snapshotTab(tab);
}

function closeTab(store, urlApi, id = store.activeTabId) {
  ensureLive(store);
  const index = store.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return false;
  const [tab] = store.tabs.splice(index, 1);
  tab.controller?.abort(new DOMException('The document tab was closed.', 'AbortError'));
  revokeTab(tab, urlApi);
  if (store.activeTabId === id) store.activeTabId = (store.tabs[index] ?? store.tabs[index - 1])?.id ?? null;
  emit(store); return true;
}

function disposeTabs(store, urlApi) {
  if (store.disposed) return;
  store.disposed = true;
  for (const tab of store.tabs) {
    tab.controller?.abort(new DOMException('The document tab store was disposed.', 'AbortError'));
    revokeTab(tab, urlApi);
  }
  store.tabs = []; store.activeTabId = null; emit(store); store.listeners.clear();
}

/**
 * Local-only, bounded document tab state. The store owns source object URLs and
 * revokes them when a tab closes or the store is disposed.
 */
export function createDocumentTabs({
  urlApi = globalThis.URL,
  maxTabs = MAX_DOCUMENT_TABS,
  idFactory = (sequence) => `document-tab-${sequence}`,
} = {}) {
  assertUrlApi(urlApi);
  if (!Number.isInteger(maxTabs) || maxTabs < 1 || maxTabs > MAX_DOCUMENT_TABS) {
    throw new RangeError(`maxTabs must be an integer from 1 to ${MAX_DOCUMENT_TABS}.`);
  }
  if (typeof idFactory !== 'function') throw new TypeError('idFactory must be a function.');

  const store = { tabs: [], activeTabId: null, maxTabs, sequence: 0, requestSequence: 0, pending: 0, disposed: false, listeners: new Set() };

  return Object.freeze({
    get state() { return snapshot(store); },
    get activeTabId() { return store.activeTabId; },
    get size() { return store.tabs.length; },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Document tab subscriber must be a function.');
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    getTab: (id) => {
      ensureLive(store);
      const tab = findTab(store, id);
      return tab ? snapshotTab(tab) : null;
    },
    open: (file, options) => openTab(store, { urlApi, idFactory }, file, options),
    activate: (id) => activateTab(store, id),
    close: (id) => closeTab(store, urlApi, id),
    update: (id, patch) => updateTab(store, id, patch),
    dispose: () => disposeTabs(store, urlApi),
  });
}

export { cloneViewerState, DEFAULT_VIEWER_STATE };
