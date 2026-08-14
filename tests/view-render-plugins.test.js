import test from 'node:test';
import {
  assert,
  CapabilityRegistry,
  deriveEditorReadiness,
  editorView,
  pluginsView,
  prototypeCoverage,
  prototypeRecords,
  prototypeSummary,
  readCssSources,
  readJson,
  registry,
  state,
} from './support/view-render-fixture.js';
import { createBlockedPluginSandboxStatus } from '../src/core/plugin-sandbox-status-contract.js';

test('plugin manager visibly labels all seven requested skeletons as unavailable', () => {
  const html = pluginsView(state());
  for (const label of ['OCR', 'Signing', 'Redaction', 'Accessibility', 'AI research map', 'AEC', 'Prepress']) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /AI research map/); // AI remains catalog-visible; professional delivery is local-deterministic
  assert.match(html, /Non-executable plugin skeleton/);
  assert.match(html, /Install unavailable/);
  assert.doesNotMatch(html, /undefined/);
});

test('plugin manager separates professional delivery from every prototype tier', () => {
  const html = pluginsView(state({
    selectedPlugin: 'skeleton:redaction',
    familyFilter: 'redaction-sanitization',
    prototypeCoverage,
    prototypeSummary,
  }));
  assert.match(html, /318\/318 prototype tiers mapped/);
  assert.match(html, new RegExp(`${prototypeSummary['executable-subset'] ?? 0}<\\/span><small>executable subsets`));
  assert.match(html, new RegExp(`${prototypeSummary['exact-alpha'] ?? 0}`));
  assert.match(html, /Skeleton \+ bridge|Core|Exact alpha|exact-alpha|implemented/i);
  assert.match(html, /professional planned/);
  assert.match(html, /external plugin disabled/);
});

test('plugin manager filter has a real empty state', () => {
  const html = pluginsView(state({ pluginQuery: 'definitely-not-a-capability' }));
  assert.match(html, /No matches/);
});

test('capability catalog exposes host diagnostics without presenting a ready execution path', () => {
  const status = createBlockedPluginSandboxStatus({
    available: true,
    bestEffort: Object.fromEntries([
      'sandboxBehaviorProbe', 'filesystemWriteDenied', 'sensitiveFilesystemReadDenied',
      'networkCanaryDenied', 'processForkCanaryDenied', 'nodePermissionProbe',
      'cpuLimitCanary', 'jitless',
    ].map((key) => [key, true])),
  }, { observedAtLocal: '2026-07-19T12:00:00.000Z' });
  const html = pluginsView(state({ probeResult: 'blocked', pluginSandboxStatus: status }));
  assert.match(html, /Third-party execution boundary/);
  assert.match(html, /<dt>Hard controls<\/dt><dd>0 \/ 5<\/dd>/);
  assert.match(html, /<dt>Diagnostic canaries<\/dt><dd>8 \/ 8<\/dd>/);
  assert.match(html, /Native OS sandbox/);
  assert.match(html, /No plugin code was executed/);
  assert.match(html, /all five production hard controls remain missing/);
  assert.doesNotMatch(html, /Every native containment requirement is verified/);
  assert.doesNotMatch(html, /executionReady[^<]*true/);
  assert.doesNotMatch(html, /plugin-sandbox-status[^>]*aria-live/);
});

test('capability catalog keeps family and row selection semantics explicit', () => {
  const html = pluginsView(state({ familyFilter: 'scan-ocr', selectedPlugin: 'skeleton:ocr' }));
  assert.match(html, /data-family="scan-ocr"[^>]*aria-pressed="true"/);
  assert.match(html, /data-family="all"[^>]*aria-pressed="false"/);
  assert.match(html, /data-plugin-row="skeleton:ocr"[^>]*aria-pressed="true"/);
  assert.match(html, /class="plugin-detail"/);
  assert.doesNotMatch(html, /class="plugin-detail"[^>]*style="[^"]*display:\s*none/);
});

test('capability catalog keeps an inline detail state when filters remove every row', () => {
  const html = pluginsView(state({ pluginQuery: 'definitely-not-a-capability' }));
  assert.match(html, /class="empty-state"/);
  assert.match(html, /class="plugin-detail-empty"/);
  assert.match(html, /No capability selected/);
});

test('capability catalog preserves retained actions and no interactive live status', () => {
  const html = pluginsView(state());
  assert.match(html, /data-action="run-sandbox-probe"/);
  assert.match(html, /data-action="show-editor"/);
  assert.match(html, /data-action="show-workflows"/);
  assert.doesNotMatch(html, /plugin-sandbox-status[^>]*aria-live/);
});

test('plugin manager disables a duplicate diagnostic request while checking', () => {
  const html = pluginsView(state({ probeResult: 'checking' }));
  assert.match(html, /data-action="run-sandbox-probe"[^>]*disabled/);
  assert.match(html, /Inspecting gate/);
  assert.match(html, /executable plugin gate remains closed/);
});

test('responsive source defines desktop and mobile workspace breakpoints', () => {
  const css = readCssSources();
  assert.match(css, /@media \(max-width: 1240px\)/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /\.plugin-layout/);
});

test('800px catalog contract stacks selected detail without intrinsic horizontal overflow', () => {
  const css = readCssSources();
  const html = pluginsView(state({ familyFilter: 'scan-ocr', selectedPlugin: 'skeleton:ocr' }));
  assert.match(css, /@media \(max-width: 1240px\)[\s\S]*?\.plugin-layout\s*\{[^}]*grid-template-columns:\s*var\(--rail-width\) 196px minmax\(380px, 1fr\)/);
  assert.match(css, /@media \(max-width: 1240px\)[\s\S]*?\.plugin-detail\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(css, /@media \(max-width: 1240px\)[\s\S]*?\.plugin-layout\s*\{[^}]*316px/);
  assert.match(html, /data-plugin-row="skeleton:ocr"[^>]*aria-pressed="true"/);
  assert.match(html, /<aside class="plugin-detail" aria-label="Selected capability details">/);
});

test('390px catalog contract keeps list and selected detail in the compact flow', () => {
  const css = readCssSources();
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.plugin-layout\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.plugin-detail\s*\{[^}]*display:\s*block[^}]*order:\s*2/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.plugin-list-panel\s*\{[^}]*order:\s*3/);
});

test('runtime catalog rejects unknown ownership and false evidence states', () => {
  const base = {
    families: readJson('catalog/families.json'),
    packs: readJson('catalog/packs.json'),
    capabilities: readJson('catalog/capabilities.json'),
  };
  assert.throws(() => new CapabilityRegistry({ ...base, capabilities: [{ ...base.capabilities[0], owner: 'missing-pack' }] }), { code: 'CATALOG_INVALID' });
  const planned = { ...base.capabilities[0], delivery: 'planned', evidence: null };
  assert.throws(() => new CapabilityRegistry({ ...base, capabilities: [{ ...planned, evidence: { kind: 'test', reference: 'false' } }] }), { code: 'CATALOG_INVALID' });
});
