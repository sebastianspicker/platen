import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilityRegistry } from '../../src/core/capability-registry.js';
import { editorView } from '../../src/ui/editor-view.js';
import { deriveEditorReadiness } from '../../src/ui/editor-readiness.js';
import { pluginsView } from '../../src/ui/plugins-view.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const readCssSources = () => {
  const facade = readFileSync(join(root, 'styles/app.css'), 'utf8');
  const importedSources = [...facade.matchAll(/@import url\(["']([^"']+)["']\);/gu)]
    .map(([, path]) => readFileSync(join(root, 'styles', path), 'utf8'));
  return importedSources.join('\n');
};
const registry = new CapabilityRegistry({
  families: readJson('catalog/families.json'),
  packs: readJson('catalog/packs.json'),
  capabilities: readJson('catalog/capabilities.json'),
});
const prototypeRecords = readJson('catalog/prototype-coverage.json').records;
const prototypeCoverage = Object.fromEntries(prototypeRecords.map((record) => [record.id, record]));
const prototypeSummary = prototypeRecords.reduce((summary, { tier }) => {
  summary[tier] = (summary[tier] ?? 0) + 1;
  return summary;
}, {});

function state(overrides = {}) {
  return {
    document: { isOpen: false, name: null, size: 0, type: null, objectUrl: null, modified: false },
    registry,
    summary: registry.summary,
    zoom: 1,
    rotation: 0,
    dragging: false,
    error: null,
    pluginQuery: '',
    familyFilter: 'all',
    selectedPlugin: 'skeleton:ocr',
    probeResult: null,
    pluginSandboxStatus: null,
    ...overrides,
  };
}

export {
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
};
