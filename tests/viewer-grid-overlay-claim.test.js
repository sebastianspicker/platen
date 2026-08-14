import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationViewActions } from '../src/ui/application-click-view-actions.js';
import { editorView } from '../src/ui/editor-view.js';
import { state } from './support/view-render-fixture.js';

const SOURCE_ID = '123e4567-e89b-42d3-a456-426614174000';
const SOURCE_SHA256 = 'c'.repeat(64);

function readyState(overrides = {}) {
  return state({
    document: { isOpen: true, name: 'grid.pdf', objectUrl: 'blob:grid', size: 4096, type: 'application/pdf', modified: false },
    analysis: {
      status: 'ready', documentId: SOURCE_ID, sha256: SOURCE_SHA256,
      inspection: { pageCount: 1 }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 },
    },
    showGrid: false,
    ...overrides,
  });
}

function toggle(value) {
  let renders = 0;
  const actions = createApplicationViewActions({
    state: value,
    controllers: { viewer: {}, lifecycle: {}, tabs: {}, documentOperations: {}, pluginPlatform: {} },
    documentApi: { querySelector: () => null }, windowApi: {},
    render: () => { renders += 1; },
    downloadOriginal() {}, exportText() {}, exportStructuredText() {}, announce() {}, showError() {},
  });
  actions['toggle-grid']();
  return renders;
}

test('grid action toggles only a source-bound open document and rerenders once', () => {
  const value = readyState();
  assert.equal(toggle(value), 1);
  assert.equal(value.showGrid, true);
  assert.match(editorView(value), /document-stage[^>]+show-grid/);
  assert.equal(toggle(value), 1);
  assert.equal(value.showGrid, false);
});

test('grid remains unavailable and hidden for closed, loading, error, or forged source state', () => {
  const hostile = [
    readyState({ document: { isOpen: false, name: null, objectUrl: null, size: 0, type: null, modified: false } }),
    readyState({ analysis: { ...readyState().analysis, status: 'loading' } }),
    readyState({ analysis: { ...readyState().analysis, status: 'error' } }),
    readyState({ analysis: { ...readyState().analysis, sha256: 'forged' } }),
  ];
  for (const value of hostile) {
    value.showGrid = false;
    assert.equal(toggle(value), 1);
    assert.equal(value.showGrid, false);
    assert.doesNotMatch(editorView({ ...value, showGrid: true }), /document-stage[^>]+show-grid/);
  }
});
