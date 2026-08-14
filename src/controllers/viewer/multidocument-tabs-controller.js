function syncActiveViewerState(state, tabs) {
  const id = tabs.activeTabId;
  if (!id) return;
  tabs.update(id, {
    viewerState: {
      zoom: state.zoom,
      rotation: state.rotation,
      selectedPage: state.selectedPage,
      viewerMode: state.viewerMode,
      searchQuery: state.searchQuery,
      searchResults: state.searchResults,
      navigationHistory: state.navigationHistory,
      navigationIndex: state.navigationIndex,
      controlledRaster: state.controlledRaster,
      loupeRaster: state.loupeRaster,
    },
  });
}

function restoreViewerState(state, tab) {
  if (!tab?.viewerState) return;
  Object.assign(state, tab.viewerState);
  state.controlledRaster = { ...tab.viewerState.controlledRaster };
  state.loupeRaster = { ...tab.viewerState.loupeRaster };
}

/**
 * Coordinates the bounded local tab store with the existing single active
 * document lifecycle. Source files and tab viewer state remain in the tab
 * store; lifecycle analysis is rehydrated only for the selected tab.
 */
export function createViewerMultiDocumentTabsController({
  state,
  tabs,
  lifecycle,
  render,
  announce,
  showError,
}) {
  if (!state || !tabs || !lifecycle || typeof render !== 'function'
    || typeof announce !== 'function' || typeof showError !== 'function') {
    throw new TypeError('Multi-document tabs controller requires state, tabs, lifecycle, and callbacks.');
  }
  let requestSequence = 0;

  async function openFile(file) {
    const requestId = ++requestSequence;
    try {
      syncActiveViewerState(state, tabs);
      const tab = await tabs.open(file);
      if (requestId !== requestSequence) {
        tabs.close(tab.id);
        return null;
      }
      state.documentTabs = tabs.state;
      render();
      try {
        await lifecycle.openFile(file);
      } catch (error) {
        if (requestId !== requestSequence) return null;
        tabs.update(tab.id, { status: 'error', error: error?.message || String(error) });
        throw error;
      }
      if (requestId !== requestSequence) return null;
      const current = tabs.getTab(tab.id);
      if (current) restoreViewerState(state, current);
      state.documentTabs = tabs.state;
      render();
      announce(`${tab.name} opened in a local tab.`);
      return current;
    } catch (error) {
      if (requestId !== requestSequence) return null;
      showError(error);
      return null;
    }
  }

  async function activateTab(id) {
    const requestId = ++requestSequence;
    if (id === tabs.activeTabId) return tabs.getTab(id);
    syncActiveViewerState(state, tabs);
    const tab = tabs.activate(id);
    if (!tab) return null;
    state.documentTabs = tabs.state;
    render();
    try {
      await lifecycle.openFile(tab.file);
    } catch (error) {
      if (requestId !== requestSequence) return null;
      throw error;
    }
    if (requestId !== requestSequence) return null;
    restoreViewerState(state, tab);
    state.documentTabs = tabs.state;
    render();
    announce(`${tab.name} is now active.`);
    return tab;
  }

  async function closeTab(id = tabs.activeTabId) {
    const requestId = ++requestSequence;
    if (!id) {
      if (state.document?.isOpen) {
        await lifecycle.closeFile();
        if (requestId !== requestSequence) return true;
        render();
        announce('Closed local document.');
        return true;
      }
      return false;
    }
    const wasActive = id === tabs.activeTabId;
    syncActiveViewerState(state, tabs);
    const closed = tabs.close(id);
    if (!closed) return false;
    state.documentTabs = tabs.state;
    if (wasActive) {
      try {
        await lifecycle.closeFile();
      } catch (error) {
        if (requestId !== requestSequence) return true;
        throw error;
      }
      if (requestId !== requestSequence) return true;
      const next = tabs.state.activeTabId ? tabs.getTab(tabs.state.activeTabId) : null;
      if (next) {
        try {
          await lifecycle.openFile(next.file);
        } catch (error) {
          if (requestId !== requestSequence) return true;
          throw error;
        }
        if (requestId !== requestSequence) return true;
        restoreViewerState(state, next);
      }
    }
    state.documentTabs = tabs.state;
    render();
    announce(wasActive ? (tabs.size ? 'Closed local tab and activated the next document.' : 'All local document tabs are closed.') : 'Closed local document tab.');
    return true;
  }

  function dispose() {
    ++requestSequence;
    syncActiveViewerState(state, tabs);
    tabs.dispose();
    state.documentTabs = tabs.state;
  }

  return Object.freeze({ openFile, activateTab, closeTab, syncActiveViewerState: () => syncActiveViewerState(state, tabs), dispose });
}
