import { escapeHtml } from './shared.js';

function tabLabel(tab) {
  const status = tab.status === 'loading' ? ' (loading)' : tab.status === 'error' ? ' (error)' : '';
  return `${tab.name}${status}`;
}

export function documentTabsView(state) {
  const tabs = Array.isArray(state.documentTabs?.tabs) ? state.documentTabs.tabs : [];
  const activeId = state.documentTabs?.activeTabId ?? null;
  if (!tabs.length) {
    return `<section class="document-tabs is-empty" aria-label="Open documents">
      <div class="document-tabs-empty">No local documents open. Choose Open PDF to start.</div>
    </section>`;
  }
  const items = tabs.map((tab) => {
    const selected = tab.id === activeId;
    const label = tabLabel(tab);
    return `<div class="document-tab ${selected ? 'is-active' : ''}">
      <button class="document-tab-button" type="button" role="tab" id="document-tab-${escapeHtml(tab.id)}" data-action="activate-document-tab" data-tab-id="${escapeHtml(tab.id)}" aria-selected="${selected ? 'true' : 'false'}" aria-controls="workspace" tabindex="${selected ? '0' : '-1'}" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</button>
      <button class="document-tab-close" type="button" data-action="close-document-tab" data-tab-id="${escapeHtml(tab.id)}" aria-label="Close ${escapeHtml(tab.name)}">×</button>
    </div>`;
  }).join('');
  return `<section class="document-tabs" aria-label="Open documents">
    <div class="document-tab-list" role="tablist" aria-label="Open local PDF documents" aria-controls="workspace">${items}</div>
    <button class="document-tab-new" type="button" data-action="open-file" aria-label="Open another local PDF">＋</button>
  </section>`;
}
