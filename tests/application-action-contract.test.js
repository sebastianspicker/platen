import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApplicationClickActions } from '../src/ui/application-click-actions.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function collectJavaScript(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectJavaScript(path);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

function inertContext() {
  return {
    state: {},
    controllers: {
      viewer: {},
      lifecycle: {},
      generation: {},
      domain: {},
      aec: {},
      pageComposition: {},
      comparison: {},
      ocr: {},
      raster: {},
      review: {},
      pdfkit: {},
      pluginPlatform: {},
      documentOperations: {},
    },
    documentApi: {},
    windowApi: {},
    render() {},
    announce() {},
    showError() {},
    downloadOriginal() {},
    exportText() {},
    exportStructuredText() {},
  };
}

test('every literal rendered application action has exactly one delegated handler', () => {
  const uiSource = collectJavaScript(join(root, 'src/ui'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  const rendered = [...uiSource.matchAll(/data-action="([^"$]+)"/gmu)]
    .map((match) => match[1]);
  const actions = Object.keys(createApplicationClickActions(inertContext()));

  assert.equal(rendered.length > 80, true, 'the contract must cover the full application action surface');
  assert.deepEqual([...new Set(rendered)].sort(), actions.sort());
});
