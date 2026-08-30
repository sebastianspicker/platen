import { icon } from './icons.js';
import { brandAndMenu, errorBanner, escapeHtml, rail } from './shared.js';

const prototypeLabels = Object.freeze({
  'exact-alpha': 'Exact alpha',
  'executable-subset': 'Executable subset',
  sidecar: 'Local sidecar',
  'service-only': 'Service/API',
  descriptor: 'Descriptor',
  proposal: 'Proposal',
  blocked: 'Blocked',
  excluded: 'Excluded',
});

const activePrototypeTiers = new Set([
  'exact-alpha',
  'executable-subset',
  'sidecar',
  'service-only',
  'descriptor',
]);

function ownDataValue(value, key) {
  return value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

function prototypeTier(state, capabilityId) {
  return ownDataValue(ownDataValue(state.prototypeCoverage, capabilityId), 'tier') ?? 'blocked';
}

function categoryList(state) {
  const allClass = state.familyFilter === 'all' ? 'is-selected' : '';
  return `<aside class="plugin-categories" aria-label="Capability families">
    <div class="panel-header"><span>Families</span></div>
    <div class="category-list">
      <button class="category-button ${allClass}" data-family="all" aria-pressed="${state.familyFilter === 'all' ? 'true' : 'false'}"><span>All families</span><span class="category-count">${state.summary.families}</span></button>
      ${state.registry.families.map((family) => {
        const count = state.registry.capabilitiesForFamily(family.id).length;
        const selected = state.familyFilter === family.id;
        return `<button class="category-button ${selected ? 'is-selected' : ''}" data-family="${escapeHtml(family.id)}" aria-pressed="${selected ? 'true' : 'false'}">
          <span>${escapeHtml(family.title)}</span><span class="category-count">${count}</span>
        </button>`;
      }).join('')}
    </div>
  </aside>`;
}

function familyRow(state, family, capabilities, selected) {
  const id = `family:${family.id}`;
  const implemented = capabilities.filter(({ delivery }) => delivery === 'implemented').length;
  const activePrototype = capabilities.filter(({ id: capabilityId }) => (
    activePrototypeTiers.has(prototypeTier(state, capabilityId))
  )).length;
  const isSelected = selected === id;
  const status = implemented ? 'Implemented' : activePrototype ? 'Prototype' : 'Planned';
  const statusClass = implemented ? 'implemented' : activePrototype ? 'executable-subset' : 'planned';
  return `<button class="plugin-row ${isSelected ? 'is-selected' : ''}" data-plugin-row="${escapeHtml(id)}" aria-pressed="${isSelected ? 'true' : 'false'}" aria-label="${escapeHtml(`${family.title} capability family`)}">
    <span class="plugin-row-icon">${icon('layers')}</span>
    <span class="plugin-row-copy"><strong>${escapeHtml(family.title)}</strong><small>${escapeHtml(family.description)}</small></span>
    <span class="plugin-row-count">${capabilities.length}</span>
    <span class="state-pill ${statusClass}">${status}</span>
  </button>`;
}

function detailPanel(state, rows) {
  const selected = rows.find(({ id }) => id === state.selectedPlugin) ?? rows[0];
  if (!selected) {
    return '<aside class="plugin-detail" aria-label="Selected capability details"><div class="plugin-detail-empty"><h2>No capability selected</h2><p>No capability matches this filter. Adjust the family or search filter to inspect a delivery record.</p></div></aside>';
  }
  const implementedCount = selected.capabilities.filter(({ delivery }) => delivery === 'implemented').length;
  const prototypeCount = selected.capabilities.filter(({ id }) => (
    activePrototypeTiers.has(prototypeTier(state, id))
  )).length;
  const runtime = prototypeCount ? 'Built-in local paths available' : 'Catalog only';
  return `<aside class="plugin-detail" aria-label="Selected capability details">
    <div class="detail-heading">
      <span class="detail-icon">${icon('layers')}</span>
      <div><p class="detail-type">Capability family</p><h2>${escapeHtml(selected.family.title)}</h2></div>
    </div>
    <p>${escapeHtml(selected.family.description)}</p>
    <div class="engine-notice">${icon('warning')}<div><strong>Delivery varies by capability</strong><br />Open each capability below for its declared delivery and prototype state.</div></div>
    <dl class="detail-facts">
      <div><dt>Capabilities</dt><dd>${selected.capabilities.length}</dd></div>
      <div><dt>Implemented</dt><dd>${implementedCount}</dd></div>
      <div><dt>Prototype paths</dt><dd>${prototypeCount}</dd></div>
      <div><dt>Catalog path</dt><dd><code>catalog/capabilities.json</code></dd></div>
      <div><dt>Runtime</dt><dd>${runtime}</dd></div>
    </dl>
    <h3>Declared functions</h3>
    <ul class="capability-list">
      ${selected.capabilities.map((capability) => {
        const tier = prototypeTier(state, capability.id);
        return `<li><span><strong>${escapeHtml(capability.title)}</strong><small>${escapeHtml(capability.description)}</small></span><span class="capability-state-stack"><span class="state-pill ${capability.delivery}">${escapeHtml(capability.delivery)}</span><span class="state-pill ${escapeHtml(tier)}">${escapeHtml(ownDataValue(prototypeLabels, tier) ?? tier)}</span></span></li>`;
      }).join('')}
    </ul>
  </aside>`;
}

export function pluginsView(state) {
  const query = state.pluginQuery.trim().toLowerCase();
  const mappedPrototypeTiers = state.prototypeCoverage && typeof state.prototypeCoverage === 'object'
    ? Object.keys(state.prototypeCoverage).length
    : 0;
  const families = state.registry.families.filter((family) => {
    if (state.familyFilter !== 'all' && state.familyFilter !== family.id) return false;
    if (!query) return true;
    const capabilities = state.registry.capabilitiesForFamily(family.id);
    const haystack = [
      family.title,
      family.description,
      ...capabilities.flatMap((item) => [item.title, item.description]),
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  });
  const rows = families.map((family) => ({
    id: `family:${family.id}`,
    family,
    capabilities: state.registry.capabilitiesForFamily(family.id),
  }));

  return `<div class="app-shell plugins-shell">
    ${brandAndMenu('plugins', { context: 'Capability delivery and metadata catalog' })}
    <div class="toolbar plugin-toolbar" role="search">
      <div class="toolbar-title"><span><strong>Capability coverage</strong><small>Delivery evidence and signed metadata records</small></span></div>
      <span class="toolbar-spacer"></span>
      <label class="search-control">${icon('search')}<span class="sr-only">Filter capabilities</span><input id="plugin-search" type="search" value="${escapeHtml(state.pluginQuery)}" placeholder="Filter families and functions" /></label>
    </div>
    <main class="workspace" id="workspace" tabindex="-1">
      <div class="plugin-layout">
        ${rail('plugins')}
        ${categoryList(state)}
        <section class="plugin-list-panel" aria-label="Capability family list">
          <dl class="plugin-summary" aria-label="Capability catalog totals">
            <div><span>${state.summary.capabilities}</span><small>mapped functions</small></div>
            <div><span>${state.summary.implemented}</span><small>implemented</small></div>
            <div><span>${state.prototypeSummary?.['executable-subset'] ?? 0}</span><small>executable subsets</small></div>
            <div><span>${state.summary.planned}</span><small>professional planned</small></div>
          </dl>
          <div class="list-heading"><span>${rows.length} families shown</span><span>Status</span></div>
          <div class="plugin-rows">
            ${rows.length ? rows.map(({ family, capabilities }) => familyRow(state, family, capabilities, state.selectedPlugin)).join('') : '<div class="empty-state"><h2>No matches</h2><p>Try a broader feature or family name.</p></div>'}
          </div>
        </section>
        ${detailPanel(state, rows)}
      </div>
    </main>
    <footer class="status-bar" role="status">
      <span class="status-dot is-neutral"></span>
      <span>Signed extension records are metadata only; no extension runtime is present.</span>
      <span class="status-spacer"></span>
      <span>${mappedPrototypeTiers}/${state.summary.capabilities} prototype tiers mapped</span>
    </footer>
    ${errorBanner(state.error)}
  </div>`;
}
