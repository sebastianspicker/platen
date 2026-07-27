import { icon } from './icons.js';
import { brandAndMenu, errorBanner, escapeHtml, rail } from './shared.js';

function fact(iconName, label, value, tone = 'verified') {
  return `<div class="trust-fact" data-tone="${tone}">
    <span class="trust-fact-icon">${icon(iconName)}</span>
    <span><strong>${label}</strong><small>${escapeHtml(value)}</small></span>
  </div>`;
}

export function trustView(state) {
  const hostStatus = state.host?.status === 'ready' ? 'Connected on this device' : 'Local host not ready';
  const sourceStatus = state.document?.isOpen
    ? `${state.document.name} is open as an immutable source`
    : 'No source document is open';
  const engineCount = Array.isArray(state.host?.engines) ? state.host.engines.length : 0;
  const capabilityCount = state.summary?.capabilities ?? 0;
  const implementedCount = state.summary?.implemented ?? 0;

  return `<div class="app-shell trust-shell">
    ${brandAndMenu('trust', { context: 'Processing boundary and limits' })}
    <header class="trust-toolbar" aria-label="Trust status">
      <span><strong>Local processing boundary</strong></span>
      <span><strong>Original source is never overwritten</strong></span>
      <span><strong>Third-party execution blocked</strong></span>
    </header>
    <main class="trust-workspace" id="workspace" tabindex="-1">
      ${rail('trust')}
      <section class="trust-content" aria-labelledby="trust-title">
        <header class="trust-intro">
          <div>
            <h1 id="trust-title">Trust &amp; limits</h1>
            <p>Platen is a local proof desk. It inspects an immutable private copy, reports bounded evidence, and creates a separate validated artifact when an operation produces output.</p>
          </div>
          <button class="button primary" type="button" data-action="show-editor">Return to Workspace</button>
        </header>

        <section class="trust-facts" aria-label="Current local status">
          ${fact('lock', 'Processing', hostStatus, state.host?.status === 'ready' ? 'verified' : 'neutral')}
          ${fact('file', 'Source', sourceStatus, state.document?.isOpen ? 'verified' : 'neutral')}
          ${fact('layers', 'Local engines', `${engineCount} engine${engineCount === 1 ? '' : 's'} reported by this host`, engineCount ? 'verified' : 'neutral')}
          ${fact('plugin', 'Capability policy', `${implementedCount} of ${capabilityCount} mapped functions are implemented`, 'attention')}
        </section>

        <div class="trust-columns">
          <section class="trust-ledger" aria-labelledby="trust-boundary-title">
            <div class="trust-section-heading"><div><h2 id="trust-boundary-title">What stays on this device</h2><p>The browser and authenticated loopback host form the entire processing boundary.</p></div></div>
            <dl class="trust-table">
              <div><dt>Document bytes</dt><dd>Remain local; no remote document upload is used.</dd><span class="trust-state is-verified">Local only</span></div>
              <div><dt>Extracted text</dt><dd>Used for local search, reflow, and bounded exports.</dd><span class="trust-state is-verified">Local only</span></div>
              <div><dt>Telemetry</dt><dd>No application telemetry or analytics runtime is included.</dd><span class="trust-state is-verified">Absent</span></div>
              <div><dt>AI runtime</dt><dd>Local-deterministic AI is implemented; remote model providers stay denied.</dd><span class="trust-state is-ready">Local only</span></div>
            </dl>
          </section>

          <aside class="trust-proof" aria-labelledby="trust-proof-title">
            <h2 id="trust-proof-title">Output contract</h2>
            <ol>
              <li><strong>Inspect the source</strong><span>Page structure, text, resources, and available signature evidence are read locally.</span></li>
              <li><strong>Run one bounded operation</strong><span>Inputs, engine access, time, memory, and output shape remain constrained.</span></li>
              <li><strong>Validate a separate result</strong><span>The original stays unchanged; promoted artifacts carry source-bound evidence.</span></li>
            </ol>
          </aside>
        </div>

        <section class="trust-limits" aria-labelledby="limits-title">
          <div class="trust-section-heading"><div><h2 id="limits-title">Claims this alpha does not make</h2><p>Unavailable and indeterminate states remain visible instead of being promoted into false assurance.</p></div></div>
          <div class="trust-limit-grid">
            <article><h3>Not Acrobat parity</h3><p>The capability ledger includes planned professional functions that are intentionally non-executable.</p></article>
            <article><h3>Not certificate identity</h3><p>Local signature evidence does not establish legal effect, signer identity, revocation, LTV, or trust on another system.</p></article>
            <article><h3>Not remote collaboration</h3><p>Projects, review records, and workflows are local or portable files, not synchronized cloud state.</p></article>
            <article><h3>Not silent mutation</h3><p>Consequential operations must produce a separate output and state their limitations explicitly.</p></article>
          </div>
        </section>
      </section>
    </main>
    <footer class="status-bar trust-status" role="status">
      <span>${icon(state.host?.status === 'ready' ? 'check' : 'warning')} ${escapeHtml(hostStatus)}</span>
      <span class="status-spacer"></span>
      <button class="status-action" type="button" data-action="show-plugins">Inspect capability policy ${icon('export')}</button>
    </footer>
    ${errorBanner(state.error)}
  </div>`;
}
