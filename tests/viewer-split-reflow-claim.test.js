import assert from 'node:assert/strict';
import test from 'node:test';
import { editorView } from '../src/ui/editor-view.js';
import { state } from './support/view-render-fixture.js';

const SOURCE_ID = '123e4567-e89b-42d3-a456-426614174000';
const SOURCE_SHA256 = 'b'.repeat(64);

function ready(mode, overrides = {}) {
  return state({
    document: { isOpen: true, name: 'reading.pdf', objectUrl: 'blob:reading', size: 4096, type: 'application/pdf', modified: false },
    analysis: {
      status: 'ready', documentId: SOURCE_ID, sha256: SOURCE_SHA256,
      inspection: { pageCount: 2 },
      textPages: [{ page: 1, text: '<script>first</script>' }, { page: 2, text: 'Second page' }],
      thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 },
    },
    viewerMode: mode,
    selectedPage: 1,
    ...overrides,
  });
}

test('source-bound reflow renders every escaped local text page read-only', () => {
  const html = editorView(ready('reflow'));
  assert.match(html, /class="reflow-view"/);
  assert.match(html, /id="reflow-page-1"/);
  assert.match(html, /id="reflow-page-2"/);
  assert.match(html, /&lt;script&gt;first&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>first<\/script>/);
});

test('source-bound split renders one immutable native page beside escaped extracted text', () => {
  const html = editorView(ready('split'));
  assert.equal((html.match(/split-native-pdf/g) ?? []).length, 1);
  assert.match(html, /Native PDF and extracted text split preview/);
  assert.match(html, /Source-bound · read-only/);
  assert.match(html, /&lt;script&gt;first&lt;\/script&gt;/);
  assert.match(html, /Source unchanged/);
});

test('loading, error, forged identity, and malformed text never render stale reflow or split content', () => {
  const base = ready('reflow').analysis;
  const hostile = [
    { ...base, status: 'loading' },
    { ...base, status: 'error' },
    { ...base, documentId: 'forged' },
    { ...base, sha256: '0'.repeat(63) },
    { ...base, textPages: [{ page: 3, text: 'stale' }] },
  ];
  for (const analysis of hostile) {
    for (const mode of ['reflow', 'split']) {
      const html = editorView(ready(mode, { analysis }));
      assert.doesNotMatch(html, /class="reflow-view"|class="split-preview"|>stale</);
      assert.match(html, /<object class="native-pdf"/);
    }
  }
});

test('split and reflow reject a forged non-local document URL before rendering content', () => {
  for (const mode of ['reflow', 'split']) {
    const html = editorView(ready(mode, {
      document: { ...ready(mode).document, objectUrl: 'https://example.test/source.pdf' },
    }));
    assert.match(html, /Local PDF preview is unavailable/);
    assert.doesNotMatch(html, /https:\/\/example\.test\/source\.pdf|class="reflow-view"|class="split-preview"/);
  }
});
