import {
  PLUGIN_SANDBOX_BEST_EFFORT_EVIDENCE,
  PLUGIN_SANDBOX_HARD_CONTROLS,
} from '../core/plugin-sandbox-status-contract.js';
import { icon } from './icons.js';
import { brandAndMenu, errorBanner, escapeHtml, rail } from './shared.js';

const skeletonByFamily = Object.freeze({
  'scan-ocr': { slug: 'ocr', label: 'OCR', detail: 'Recognition and scan cleanup' },
  signatures: { slug: 'signing', label: 'Signing', detail: 'Local electronic, certificate, and audit workflows' },
  'redaction-sanitization': { slug: 'redaction', label: 'Redaction', detail: 'Permanent removal and hidden-data cleanup' },
  accessibility: { slug: 'accessibility-remediation', label: 'Accessibility', detail: 'Checks, tags, reading order, and alt text' },
  ai: { slug: 'ai', label: 'AI research map', detail: 'Local-deterministic AI delivery; no remote model providers' },
  aec: { slug: 'aec', label: 'AEC', detail: 'Calibrated measurement, takeoff, and local projects' },
  'standards-preflight-print': { slug: 'prepress', label: 'Prepress', detail: 'PDF standards, preflight, fixups, and output preview' },
});

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

const activePrototypeTiers = new Set(['exact-alpha', 'executable-subset', 'sidecar', 'service-only', 'descriptor']);

const sandboxControlLabels = Object.freeze({
  osSandbox: 'Native OS sandbox',
  noNetwork: 'Enforced network denial',
  processQuota: 'Descendant process quota',
  cpuQuota: 'Aggregate CPU quota',
  hardMemoryQuota: 'Hard memory ceiling',
});

const sandboxEvidenceLabels = Object.freeze({
  sandboxBehaviorProbe: 'Experimental sandbox behavior',
  filesystemWriteDenied: 'Filesystem write canary denied',
  sensitiveFilesystemReadDenied: 'Sensitive read canary denied',
  networkCanaryDenied: 'Network canary denied',
  processForkCanaryDenied: 'Process fork canary denied',
  nodePermissionProbe: 'Node permission canary',
  cpuLimitCanary: 'CPU limit canary',
  jitless: 'JIT disabled in diagnostic process',
});

const sandboxReasonLabels = Object.freeze({
  BEST_EFFORT_CANARIES_PASSED: 'Every diagnostic canary was observed. These checks do not provide production containment.',
  BEST_EFFORT_CANARIES_INCOMPLETE: 'Some diagnostic canaries were not observed. Production containment is still unavailable.',
  PROBE_UNAVAILABLE: 'The local diagnostic probe is unavailable. Production containment is still unavailable.',
});

function ownDataValue(value, key) {
  return value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

function skeletonFor(familyId) {
  return ownDataValue(skeletonByFamily, familyId);
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

function skeletonRow(state, family, capabilities, selected) {
  const skeleton = skeletonFor(family.id);
  const id = skeleton ? `skeleton:${skeleton.slug}` : `family:${family.id}`;
  const implemented = capabilities.filter(({ delivery }) => delivery === 'implemented').length;
  const activePrototype = capabilities.filter(({ id }) => activePrototypeTiers.has(prototypeTier(state, id))).length;
  const label = skeleton?.label ?? family.title;
  const description = skeleton?.detail ?? family.description;
  const isSelected = selected === id;
  return `<button class="plugin-row ${isSelected ? 'is-selected' : ''}" data-plugin-row="${escapeHtml(id)}" aria-pressed="${isSelected ? 'true' : 'false'}" aria-label="${escapeHtml(`${label} capability family`)}">
    <span class="plugin-row-icon">${icon(skeleton ? 'plugin' : 'layers')}</span>
    <span class="plugin-row-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span>
    <span class="plugin-row-count">${capabilities.length}</span>
    <span class="state-pill ${implemented ? 'implemented' : activePrototype ? 'executable-subset' : 'planned'}">${skeleton ? activePrototype ? 'Skeleton + bridge' : 'Skeleton' : implemented ? 'Core' : activePrototype ? 'Prototype' : 'Planned'}</span>
  </button>`;
}

function sandboxEvidenceList(keys, labels, evidence, { missing = false } = {}) {
  return `<ul class="sandbox-evidence-list">${keys.map((key) => {
    const observed = ownDataValue(evidence, key) === true;
    const stateClass = observed ? ' is-observed' : '';
    const stateLabel = missing ? 'Missing' : observed ? 'Observed' : 'Not observed';
    return `<li><span>${escapeHtml(ownDataValue(labels, key))}</span><span class="sandbox-evidence-state${stateClass}">${stateLabel}</span></li>`;
  }).join('')}</ul>`;
}

function sandboxStatusPanel(state) {
  const status = state.pluginSandboxStatus;
  const checking = state.probeResult === 'checking';
  const observedCount = status
    ? PLUGIN_SANDBOX_BEST_EFFORT_EVIDENCE.filter((key) => ownDataValue(status.bestEffortEvidence, key) === true).length
    : 0;
  const message = state.host?.pluginSandboxProbeReady === false
    ? 'This host build does not expose the optional diagnostic probe. Production containment remains unavailable.'
    : checking
    ? 'The local host is running bounded diagnostic canaries. Plugin execution remains blocked.'
    : status
      ? ownDataValue(sandboxReasonLabels, status.reasonCode) ?? 'Diagnostic reason unavailable. Production containment remains unavailable.'
      : state.probeResult === 'failed'
        ? 'The diagnostic request failed. Production plugin containment remains unavailable.'
        : 'Run the optional local diagnostic to inspect best-effort canaries. It cannot open the execution gate.';
  const timestamp = status
    ? ` Cached for this host session at ${escapeHtml(status.observedAtLocal)}.`
    : '';
  return `<details class="plugin-sandbox-status">
    <summary>
      <span class="sandbox-status-heading"><span class="sandbox-lock">${icon('lock')}</span><span><h3 id="sandbox-status-title">Third-party execution boundary</h3><small>${message}</small></span></span>
      <span class="state-pill blocked">${checking ? 'Checking' : 'Blocked'}</span>
    </summary>
    <div class="sandbox-status-details">
      <dl class="sandbox-status-counts">
        <div><dt>Hard controls</dt><dd>0 / ${PLUGIN_SANDBOX_HARD_CONTROLS.length}</dd></div>
        <div><dt>Diagnostic canaries</dt><dd>${observedCount} / ${PLUGIN_SANDBOX_BEST_EFFORT_EVIDENCE.length}</dd></div>
      </dl>
      <h4>Required hard controls</h4>
      ${sandboxEvidenceList(PLUGIN_SANDBOX_HARD_CONTROLS, sandboxControlLabels, status?.hardControls, { missing: true })}
      <h4>Best-effort diagnostics</h4>
      ${sandboxEvidenceList(PLUGIN_SANDBOX_BEST_EFFORT_EVIDENCE, sandboxEvidenceLabels, status?.bestEffortEvidence)}
      <p class="sandbox-status-disclosure">No plugin code was executed. Diagnostic evidence never promotes a hard control.${timestamp}</p>
    </div>
  </details>`;
}

function detailPanel(state, rows) {
  const selected = rows.find(({ id }) => id === state.selectedPlugin) ?? rows[0];
  if (!selected) return '<aside class="plugin-detail" aria-label="Selected capability details"><div class="plugin-detail-empty"><h2>No capability selected</h2><p>No capability matches this filter. Adjust the family or search filter to inspect a delivery record.</p></div></aside>';
  const skeleton = skeletonFor(selected.family.id);
  const path = skeleton ? `plugins/skeletons/${skeleton.slug}/` : 'catalog/capabilities.json';
  const implementedCount = selected.capabilities.filter(({ delivery }) => delivery === 'implemented').length;
  const prototypeCount = selected.capabilities.filter(({ id }) => activePrototypeTiers.has(prototypeTier(state, id))).length;
  const skeletonHeading = prototypeCount ? 'Trusted local bridge available' : 'Engine required';
  const skeletonMessage = prototypeCount
    ? `${prototypeCount} function${prototypeCount === 1 ? '' : 's'} have an exact, subset, sidecar, service, or descriptor path. The broader third-party skeleton remains non-executable.`
    : 'No executable manifest or implementation is included. Activation is intentionally unavailable.';
  return `<aside class="plugin-detail" aria-label="Selected capability details">
    <div class="detail-heading">
      <span class="detail-icon">${icon(skeleton ? 'plugin' : 'layers')}</span>
      <div><p class="detail-type">${skeleton ? 'Non-executable plugin skeleton' : 'Capability family'}</p><h2>${escapeHtml(skeleton?.label ?? selected.family.title)}</h2></div>
    </div>
    <p>${escapeHtml(selected.family.description)}</p>
    <div class="engine-notice">${icon('warning')}<div><strong>${skeleton ? skeletonHeading : 'Delivery varies'}</strong><br />${skeleton ? skeletonMessage : 'Open each capability below for its declared delivery state.'}</div></div>
    <dl class="detail-facts">
      <div><dt>Capabilities</dt><dd>${selected.capabilities.length}</dd></div>
      <div><dt>Implemented</dt><dd>${implementedCount}</dd></div>
      <div><dt>Prototype paths</dt><dd>${prototypeCount}</dd></div>
      <div><dt>Contract path</dt><dd><code>${escapeHtml(path)}</code></dd></div>
      <div><dt>Runtime</dt><dd>${skeleton ? prototypeCount ? 'Built-in bridge; external plugin disabled' : 'Unavailable' : prototypeCount ? 'Built-in prototype paths' : 'Catalog only'}</dd></div>
    </dl>
    <h3>Declared functions</h3>
    <ul class="capability-list">
      ${selected.capabilities.map((capability) => {
        const tier = prototypeTier(state, capability.id);
        return `<li><span><strong>${escapeHtml(capability.title)}</strong><small>${escapeHtml(capability.description)}</small></span><span class="capability-state-stack"><span class="state-pill ${capability.delivery}">${escapeHtml(capability.delivery)}</span><span class="state-pill ${escapeHtml(tier)}">${escapeHtml(ownDataValue(prototypeLabels, tier) ?? tier)}</span></span></li>`;
      }).join('')}
    </ul>
    ${skeleton ? '<button class="button" disabled>Install unavailable</button>' : ''}
  </aside>`;
}

export function pluginsView(state) {
  const query = state.pluginQuery.trim().toLowerCase();
  const mappedPrototypeTiers = state.prototypeCoverage && typeof state.prototypeCoverage === 'object'
    ? Object.keys(state.prototypeCoverage).length : 0;
  const families = state.registry.families.filter((family) => {
    if (state.familyFilter !== 'all' && state.familyFilter !== family.id) return false;
    if (!query) return true;
    const haystack = [family.title, family.description, ...state.registry.capabilitiesForFamily(family.id).flatMap((item) => [item.title, item.description])].join(' ').toLowerCase();
    return haystack.includes(query);
  });
  const rows = families.map((family) => ({
    id: skeletonFor(family.id) ? `skeleton:${skeletonFor(family.id).slug}` : `family:${family.id}`,
    family,
    capabilities: state.registry.capabilitiesForFamily(family.id),
  }));
  const probeChecking = state.probeResult === 'checking';
  const probeDisabled = probeChecking || state.host?.pluginSandboxProbeReady === false;
  const probeLabel = probeChecking ? 'Inspecting gate…' : 'Inspect execution gate';
  const footerMessage = probeChecking
    ? 'Diagnostic containment probe running; executable plugin gate remains closed'
    : state.probeResult === 'blocked'
      ? 'Host diagnostics recorded; all five production hard controls remain missing'
      : state.probeResult === 'failed'
        ? 'Diagnostic probe unavailable; executable plugin gate remains closed'
        : 'Executable plugin gate closed; packages and skeletons are non-executing';

  return `<div class="app-shell plugins-shell">
    ${brandAndMenu('plugins', { context: 'Delivery and execution policy' })}
    <div class="toolbar plugin-toolbar" role="search">
      <div class="toolbar-title"><span><strong>Capability coverage</strong><small>Delivery, evidence, and execution policy</small></span></div>
      <span class="toolbar-spacer"></span>
      <label class="search-control">${icon('search')}<span class="sr-only">Filter capabilities</span><input id="plugin-search" type="search" value="${escapeHtml(state.pluginQuery)}" placeholder="Filter families and functions" /></label>
      <button class="button" data-action="run-sandbox-probe" aria-describedby="sandbox-status-title" ${probeDisabled ? 'disabled' : ''}><span class="probe-label">${probeLabel}</span></button>
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
          ${sandboxStatusPanel(state)}
          <div class="list-heading"><span>${rows.length} families shown</span><span>Status</span></div>
          <div class="plugin-rows">
            ${rows.length ? rows.map(({ family, capabilities }) => skeletonRow(state, family, capabilities, state.selectedPlugin)).join('') : '<div class="empty-state"><h2>No matches</h2><p>Try a broader feature or family name.</p></div>'}
          </div>
        </section>
        ${detailPanel(state, rows)}
      </div>
    </main>
    <footer class="status-bar" role="status">
      <span class="status-dot is-neutral"></span>
      <span>${footerMessage}</span>
      <span class="status-spacer"></span>
      <span>7 advanced skeletons · ${mappedPrototypeTiers}/${state.summary.capabilities} prototype tiers mapped</span>
    </footer>
    ${errorBanner(state.error)}
  </div>`;
}
