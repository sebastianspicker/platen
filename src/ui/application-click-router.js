import { createApplicationClickActions } from './application-click-actions.js';
import { routeApplicationClickTarget } from './application-click-target-router.js';

export function bindApplicationClickEvents({
  root,
  state,
  controllers,
  document: documentApi = globalThis.document,
  window: windowApi = globalThis.window,
  render,
  announce,
  showError,
  downloadOriginal,
  exportText,
  exportStructuredText,
}) {
  const callbacks = [render, announce, showError, downloadOriginal, exportText, exportStructuredText];
  if (!root || !state || !controllers || !documentApi || !windowApi
    || callbacks.some((callback) => typeof callback !== 'function')) {
    throw new TypeError('Application click router requires UI roots, controllers, and callbacks.');
  }

  const context = {
    state,
    controllers,
    documentApi,
    windowApi,
    render,
    announce,
    showError,
    downloadOriginal,
    exportText,
    exportStructuredText,
  };
  const actions = createApplicationClickActions(context);
  async function handleClick(event) {
    if (await routeApplicationClickTarget({ event, state, controllers, render })) return;
    const actionElement = event.target.closest('[data-action]');
    if (!actionElement) return;
    await actions[actionElement.dataset.action]?.(actionElement);
  }

  root.addEventListener('click', handleClick);
  return () => root.removeEventListener('click', handleClick);
}
