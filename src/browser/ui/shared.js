import { icon } from './icons.js';

const routeDetails = Object.freeze({
  editor: {
    label: 'Workspace',
    description: 'Source, preview, and evidence',
    icon: 'grid',
  },
  workflows: {
    label: 'Operations',
    description: 'Bounded local document actions',
    icon: 'settings',
  },
  plugins: {
    label: 'Coverage',
    description: 'Delivery and execution policy',
    icon: 'layers',
  },
  trust: {
    label: 'Trust',
    description: 'Processing boundary and limits',
    icon: 'lock',
  },
});

function routeFor(id) {
  return Object.getOwnPropertyDescriptor(routeDetails, id)?.value ?? routeDetails.editor;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function brandAndMenu(active, { context } = {}) {
  const route = routeFor(active);
  const openAction = active === 'editor'
    ? `<button class="menu-open-action" type="button" data-action="open-file">${icon('folder')}<span>Open PDF</span></button>`
    : '';
  return `
    <header class="menu-bar">
      <div class="brand">
        <span class="brand-wordmark">Platen<span>The local-first PDF workbench.</span></span>
      </div>
      <div class="route-context" aria-label="Current area">
        ${icon(route.icon)}
        <span><strong>${route.label}</strong><small>${escapeHtml(context ?? route.description)}</small></span>
      </div>
      <span class="menu-spacer"></span>
      <div class="local-control-cluster">
        ${openAction}
        <div class="local-only-state" aria-label="All processing stays on this device">
          <span>Local only</span>
        </div>
      </div>
    </header>`;
}

export function rail(active) {
  const destination = (id, actionAttribute, actionLabel) => {
    const route = routeFor(id);
    const current = active === id;
    return `<button class="rail-button ${current ? 'is-selected' : ''}" type="button" ${actionAttribute} ${current ? 'aria-current="page"' : ''} aria-label="${route.label}" title="${route.description}">${icon(route.icon)}<span>${actionLabel}</span></button>`;
  };
  return `
    <nav class="tool-rail" aria-label="Application">
      ${destination('editor', 'data-action="show-editor"', 'Workspace')}
      ${destination('workflows', 'data-action="show-workflows"', 'Operations')}
      ${destination('plugins', 'data-action="show-plugins"', 'Coverage')}
      <span class="rail-spacer" aria-hidden="true"></span>
      ${destination('trust', 'data-action="show-about"', 'Trust')}
    </nav>`;
}

export function errorBanner(message) {
  if (!message) return '';
  return `<div id="error-banner" class="error-banner" role="alert" tabindex="-1">
    <span>${icon('warning')}</span>
    <span>${escapeHtml(message)}</span>
    <button class="icon-button" type="button" data-action="dismiss-error" aria-label="Dismiss error">${icon('close')}</button>
  </div>`;
}
