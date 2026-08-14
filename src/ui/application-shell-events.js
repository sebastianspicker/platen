import { fileFromDrop } from '../core/ui-actions.js';

const TAB_NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

function hasApplicationShellDependencies({
  root, state, session, lifecycle, generation, documentApi, windowApi, render,
}) {
  return [root, state, session, lifecycle, generation, documentApi, windowApi].every(Boolean)
    && typeof render === 'function';
}

function nextTabNavigation(event, state) {
  const tabButton = event.target.closest?.('[role="tab"][data-tab-id]');
  if (!tabButton || !TAB_NAVIGATION_KEYS.has(event.key)) return null;

  const tabItems = state.documentTabs?.tabs ?? [];
  const currentIndex = tabItems.findIndex(({ id }) => id === tabButton.dataset.tabId);
  if (currentIndex < 0) return null;

  if (event.key === 'Home') return { id: tabItems[0].id };
  if (event.key === 'End') return { id: tabItems[tabItems.length - 1].id };
  const offset = event.key === 'ArrowLeft' ? -1 : 1;
  return { id: tabItems[(currentIndex + offset + tabItems.length) % tabItems.length].id };
}

function isCommandShortcut(event, key) {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === key;
}

function bindListeners(listeners) {
  for (const [target, eventName, listener] of listeners) {
    target.addEventListener(eventName, listener);
  }
  return () => {
    for (const [target, eventName, listener] of listeners) {
      target.removeEventListener(eventName, listener);
    }
  };
}

export function bindApplicationShellEvents({
  root,
  state,
  session,
  lifecycle,
  tabs,
  generation,
  document: documentApi = globalThis.document,
  window: windowApi = globalThis.window,
  render,
}) {
  if (!hasApplicationShellDependencies({
    root, state, session, lifecycle, generation, documentApi, windowApi, render,
  })) {
    throw new TypeError('Application shell events require UI roots, session, controllers, and render.');
  }

  function handleDragEnter(event) {
    event.preventDefault();
    if (!state.dragging) {
      state.dragging = true;
      render();
    }
  }

  function handleDragLeave(event) {
    if (event.relatedTarget && root.contains(event.relatedTarget)) return;
    state.dragging = false;
    render();
  }

  function handleDrop(event) {
    event.preventDefault();
    state.dragging = false;
    const file = fileFromDrop(event);
    if (file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''))) {
      (tabs?.openFile ?? lifecycle.openFile)(file);
    } else if (file) {
      generation.convertLocalFile(file);
    } else {
      render();
    }
  }

  function handleKeydown(event) {
    const nextTab = nextTabNavigation(event, state);
    if (nextTab) {
      event.preventDefault();
      const nextButton = [...(documentApi.querySelectorAll?.('[role="tab"][data-tab-id]') ?? [])]
        .find((element) => element.dataset.tabId === nextTab.id);
      nextButton?.focus();
      void tabs?.activateTab(nextTab.id);
      return;
    }
    if (isCommandShortcut(event, 'o')) {
      event.preventDefault();
      documentApi.querySelector('#file-picker')?.click();
    }
    if (isCommandShortcut(event, 'f')
      && state.analysis.textPages.length) {
      event.preventDefault();
      documentApi.querySelector('#document-search')?.focus();
    }
  }

  function handleBeforeUnload() {
    lifecycle.dispose();
    tabs?.dispose?.();
  }

  function handleFullscreenChange() {
    if (!documentApi.fullscreenElement && state.presentationMode) {
      state.presentationMode = false;
      render();
    }
  }

  const unbindListeners = bindListeners([
    [root, 'dragenter', handleDragEnter],
    [root, 'dragover', handleDragEnter],
    [root, 'dragleave', handleDragLeave],
    [root, 'drop', handleDrop],
    [windowApi, 'keydown', handleKeydown],
    [windowApi, 'beforeunload', handleBeforeUnload],
    [documentApi, 'fullscreenchange', handleFullscreenChange],
  ]);
  const unsubscribe = session.subscribe((snapshot) => { state.document = snapshot; });

  return () => {
    unbindListeners();
    unsubscribe();
  };
}
