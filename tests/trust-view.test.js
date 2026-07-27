import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trustView } from '../src/ui/trust-view.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function state(overrides = {}) {
  return {
    document: { isOpen: true, name: 'drawing.pdf' },
    host: { status: 'ready', engines: ['poppler', 'tesseract'] },
    summary: { capabilities: 318, implemented: 43 },
    error: null,
    ...overrides,
  };
}

test('trust route presents the local processing and derived-output contract as a page', () => {
  const html = trustView(state());
  assert.match(html, /<h1 id="trust-title">Trust &amp; limits<\/h1>/);
  assert.match(html, /data-action="show-about"[^>]*aria-current="page"[^>]*aria-label="Trust"/);
  assert.match(html, /Document bytes[\s\S]*Local only/);
  assert.match(html, /original source is never overwritten/i);
  assert.match(html, /Not Acrobat parity/);
  assert.match(html, /data-action="show-editor"/);
  assert.match(html, /data-action="show-plugins"/);
  assert.doesNotMatch(html, /role="alert"/);
});

test('trust route escapes live document names and represents neutral host state', () => {
  const html = trustView(state({
    document: { isOpen: true, name: '<private>.pdf' },
    host: { status: 'unavailable', engines: [] },
  }));
  assert.match(html, /&lt;private&gt;\.pdf/);
  assert.doesNotMatch(html, /<private>/);
  assert.match(html, /Local host not ready/);
  assert.match(html, /data-tone="neutral"/);
});

test('trust route has desktop and compact responsive layouts', () => {
  const css = [
    'trust.css',
    'responsive.css',
    'mobile.css',
  ].map((name) => readFileSync(join(root, 'styles', name), 'utf8')).join('\n');
  assert.match(css, /\.trust-workspace\s*\{[^}]*grid-template-columns:\s*var\(--rail-width\) minmax\(0, 1fr\)/s);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.trust-workspace\s*\{[^}]*display:\s*block/s);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.tool-rail\s*\{[^}]*grid-template-columns:\s*repeat\(4, 1fr\)/s);
});
