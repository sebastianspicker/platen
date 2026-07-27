import { fileFromDrop } from '../core/ui-actions.js';

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
  if (!root || !state || !session || !lifecycle || !generation
    || !documentApi || !windowApi || typeof render !== 'function') {
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
    const tabButton = event.target.closest?.('[role="tab"][data-tab-id]');
    if (tabButton && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const tabItems = state.documentTabs?.tabs ?? [];
      const currentIndex = tabItems.findIndex(({ id }) => id === tabButton.dataset.tabId);
      if (currentIndex >= 0) {
        const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabItems.length - 1 : (currentIndex + offset + tabItems.length) % tabItems.length;
        const next = tabItems[index];
        event.preventDefault();
        const nextButton = [...(documentApi.querySelectorAll?.('[role="tab"][data-tab-id]') ?? [])]
          .find((element) => element.dataset.tabId === next.id);
        nextButton?.focus();
        void tabs?.activateTab(next.id);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      documentApi.querySelector('#file-picker')?.click();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f'
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

  root.addEventListener('dragenter', handleDragEnter);
  root.addEventListener('dragover', handleDragEnter);
  root.addEventListener('dragleave', handleDragLeave);
  root.addEventListener('drop', handleDrop);
  windowApi.addEventListener('keydown', handleKeydown);
  windowApi.addEventListener('beforeunload', handleBeforeUnload);
  documentApi.addEventListener('fullscreenchange', handleFullscreenChange);
  const unsubscribe = session.subscribe((snapshot) => { state.document = snapshot; });

  return () => {
    root.removeEventListener('dragenter', handleDragEnter);
    root.removeEventListener('dragover', handleDragEnter);
    root.removeEventListener('dragleave', handleDragLeave);
    root.removeEventListener('drop', handleDrop);
    windowApi.removeEventListener('keydown', handleKeydown);
    windowApi.removeEventListener('beforeunload', handleBeforeUnload);
    documentApi.removeEventListener('fullscreenchange', handleFullscreenChange);
    unsubscribe();
  };
}
