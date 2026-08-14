import assert from 'node:assert/strict';
import test from 'node:test';
import { resetDocumentState } from '../src/controllers/document-lifecycle/state-reset.js';
import { createApplicationViewActions } from '../src/ui/application-click-view-actions.js';
import { editorView } from '../src/ui/editor-view.js';
import { state } from './support/view-render-fixture.js';

const SOURCE_ID = '123e4567-e89b-42d3-a456-426614174000';
const SOURCE_SHA256 = 'a'.repeat(64);

function readyState(overrides = {}) {
  return state({
    document: { isOpen: true, name: 'layouts.pdf', objectUrl: 'blob:layouts', size: 4096, type: 'application/pdf', modified: false },
    analysis: {
      status: 'ready', documentId: SOURCE_ID, sha256: SOURCE_SHA256,
      inspection: { pageCount: 5 }, textPages: [], thumbnails: [], fonts: [], images: [], attachments: [], signatures: { count: 0 },
    },
    selectedPage: 1,
    viewerMode: 'native',
    viewerPageLayout: 'single',
    ...overrides,
  });
}

function viewActions(stateValue) {
  let renders = 0;
  const actions = createApplicationViewActions({
    state: stateValue,
    controllers: {
      viewer: {}, lifecycle: {}, tabs: {}, documentOperations: {}, pluginPlatform: {},
    },
    documentApi: { querySelector: () => null }, windowApi: {},
    render: () => { renders += 1; },
    downloadOriginal() {}, exportText() {}, exportStructuredText() {}, announce() {}, showError() {},
  });
  return { actions, renders: () => renders };
}

test('page-layout control cycles all four exact modes and renders once per transition', () => {
  const value = readyState();
  const { actions, renders } = viewActions(value);
  const observed = [];
  for (let index = 0; index < 4; index += 1) {
    actions['cycle-page-layout']();
    observed.push(value.viewerPageLayout);
  }
  assert.deepEqual(observed, ['continuous', 'facing', 'cover-facing', 'single']);
  assert.equal(renders(), 4);
});

test('continuous, facing, and cover-facing layouts render the resolved local PDF pages', () => {
  const continuous = editorView(readyState({ viewerPageLayout: 'continuous' }));
  assert.match(continuous, /class="page-layout-view layout-continuous"/);
  assert.equal((continuous.match(/layout-native-pdf/g) ?? []).length, 5);
  for (let page = 1; page <= 5; page += 1) assert.match(continuous, new RegExp(`#page=${page}&amp;toolbar=0`));

  const facing = editorView(readyState({ viewerPageLayout: 'facing', selectedPage: 4 }));
  assert.equal((facing.match(/layout-native-pdf/g) ?? []).length, 2);
  assert.match(facing, /#page=3&amp;toolbar=0/);
  assert.match(facing, /#page=4&amp;toolbar=0/);

  const cover = editorView(readyState({ viewerPageLayout: 'cover-facing', selectedPage: 1 }));
  assert.equal((cover.match(/layout-native-pdf/g) ?? []).length, 1);
  assert.match(cover, /#page=1&amp;toolbar=0/);
});

test('continuous layout is bounded and stale or forged analysis falls back to one native preview', () => {
  const textPages = [];
  const bounded = editorView(readyState({
    viewerPageLayout: 'continuous',
    analysis: { ...readyState().analysis, inspection: { pageCount: 33 }, textPages },
  }));
  assert.equal((bounded.match(/layout-native-pdf/g) ?? []).length, 32);
  assert.match(bounded, /Continuous view is bounded to the first 32 pages/);

  for (const analysis of [
    { ...readyState().analysis, status: 'loading' },
    { ...readyState().analysis, sha256: 'forged' },
  ]) {
    const html = editorView(readyState({ viewerPageLayout: 'continuous', analysis }));
    assert.doesNotMatch(html, /page-layout-view|layout-native-pdf/);
    assert.match(html, /<object class="native-pdf"/);
  }
  const remote = editorView(readyState({
    viewerPageLayout: 'continuous',
    document: { ...readyState().document, objectUrl: 'https://example.test/source.pdf' },
  }));
  assert.match(remote, /Local PDF preview is unavailable/);
  assert.doesNotMatch(remote, /https:\/\/example\.test\/source\.pdf/);
});

test('document reset clears layout, view mode, and grid state before another source opens', () => {
  const value = { viewerMode: 'split', viewerPageLayout: 'facing', showGrid: true };
  resetDocumentState(value, () => {}, { opening: false });
  assert.equal(value.viewerMode, 'native');
  assert.equal(value.viewerPageLayout, 'single');
  assert.equal(value.showGrid, false);
  assert.equal(value.analysis.status, 'idle');
});
