import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import test from 'node:test';
import { createDocumentTabs, MAX_DOCUMENT_TABS } from '../src/core/document-tabs.js';
import { createViewerMultiDocumentTabsController } from '../src/controllers/viewer/multidocument-tabs-controller.js';

function file(name, contents = '%PDF-1.7\nfixture') {
  return new File([contents], name, { type: 'application/pdf' });
}

function urls() {
  const revoked = [];
  let next = 0;
  return {
    revoked,
    api: {
      createObjectURL: () => `blob:tab-${++next}`,
      revokeObjectURL: (value) => revoked.push(value),
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('document tabs keep stable identities, explicit activation, and isolated viewer state', async () => {
  const fixture = urls();
  const tabs = createDocumentTabs({ urlApi: fixture.api, maxTabs: 3 });
  const first = await tabs.open(file('one.pdf'));
  const second = await tabs.open(file('two.pdf'));
  assert.notEqual(first.id, second.id);
  assert.equal(tabs.activeTabId, second.id);
  tabs.update(first.id, { viewerState: { selectedPage: 4, zoom: 1.5 } });
  tabs.activate(first.id);
  assert.equal(tabs.getTab(first.id).viewerState.selectedPage, 4);
  assert.equal(tabs.getTab(second.id).viewerState.selectedPage, 1);
  assert.equal(tabs.getTab(first.id).viewerState.zoom, 1.5);
});

test('tab count is bounded and close activates the next tab then previous tab', async () => {
  const fixture = urls();
  const tabs = createDocumentTabs({ urlApi: fixture.api, maxTabs: 2 });
  const first = await tabs.open(file('one.pdf'));
  const second = await tabs.open(file('two.pdf'));
  await assert.rejects(() => tabs.open(file('three.pdf')), { code: 'MAX_DOCUMENT_TABS' });
  tabs.activate(first.id);
  tabs.close(first.id);
  assert.equal(tabs.activeTabId, second.id);
  tabs.close(second.id);
  assert.equal(tabs.activeTabId, null);
  assert.deepEqual(fixture.revoked, ['blob:tab-1', 'blob:tab-2']);
});

test('closing and disposing tabs revoke each local URL exactly once', async () => {
  const fixture = urls();
  const tabs = createDocumentTabs({ urlApi: fixture.api });
  const first = await tabs.open(file('one.pdf'));
  await tabs.open(file('two.pdf'));
  tabs.close(first.id);
  tabs.close(first.id);
  tabs.dispose();
  tabs.dispose();
  assert.deepEqual(fixture.revoked, ['blob:tab-1', 'blob:tab-2']);
});

test('stale async load completion cannot mutate a closed tab', async () => {
  const fixture = urls();
  const tabs = createDocumentTabs({ urlApi: fixture.api, maxTabs: MAX_DOCUMENT_TABS });
  let finish;
  let loadSignal;
  let startLoad;
  const loadStarted = new Promise((resolve) => { startLoad = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const opened = tabs.open(file('stale.pdf'), {
    load: async (_source, { signal }) => { loadSignal = signal; startLoad(); await pending; return { pageCount: 99 }; },
  });
  await loadStarted;
  const id = tabs.activeTabId;
  tabs.close(id);
  assert.equal(loadSignal.aborted, true);
  finish();
  await opened;
  assert.equal(tabs.getTab(id), null);
  assert.deepEqual(fixture.revoked, ['blob:tab-1']);
});

test('independent tab loads complete even when another tab opens later', async () => {
  const fixture = urls();
  const tabs = createDocumentTabs({ urlApi: fixture.api, maxTabs: 3 });
  const firstLoad = deferred();
  const secondLoad = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const firstOpen = tabs.open(file('first.pdf'), { load: async () => { firstStarted.resolve(); await firstLoad.promise; return { pageCount: 1 }; } });
  await firstStarted.promise;
  const secondOpen = tabs.open(file('second.pdf'), { load: async () => { secondStarted.resolve(); await secondLoad.promise; return { pageCount: 2 }; } });
  await secondStarted.promise;
  firstLoad.resolve();
  await firstOpen;
  assert.equal(tabs.getTab('document-tab-1').status, 'ready');
  assert.equal(tabs.getTab('document-tab-2').status, 'loading');
  secondLoad.resolve();
  await secondOpen;
  assert.equal(tabs.getTab('document-tab-2').status, 'ready');
});

test('closing an unrelated tab does not suppress a live tab load', async () => {
  const fixture = urls();
  const tabs = createDocumentTabs({ urlApi: fixture.api, maxTabs: 3 });
  const load = deferred();
  const started = deferred();
  const first = await tabs.open(file('first.pdf'));
  const secondOpen = tabs.open(file('second.pdf'), { load: async () => { started.resolve(); await load.promise; return { pageCount: 2 }; } });
  await started.promise;
  tabs.close(first.id);
  load.resolve();
  await secondOpen;
  assert.equal(tabs.getTab('document-tab-2').status, 'ready');
});

test('concurrent opens cannot exceed the tab bound while header checks are pending', async () => {
  const fixture = urls();
  const tabs = createDocumentTabs({ urlApi: fixture.api, maxTabs: 1 });
  const first = tabs.open(file('first.pdf'));
  await assert.rejects(() => tabs.open(file('second.pdf')), { code: 'MAX_DOCUMENT_TABS' });
  await first;
  assert.equal(tabs.size, 1);
});

test('tabs controller rehydrates isolated viewer state when activating a document', async () => {
  const fixture = urls();
  const tabs = createDocumentTabs({ urlApi: fixture.api, maxTabs: 2 });
  const state = {
    zoom: 1, rotation: 0, selectedPage: 1, viewerMode: 'native', searchQuery: '', searchResults: [],
    navigationHistory: [1], navigationIndex: 0,
    controlledRaster: { status: 'idle', page: null, url: null, error: null },
    loupeRaster: { status: 'idle', page: null, url: null, error: null },
  };
  const opened = [];
  const lifecycle = { openFile: async (value) => opened.push(value.name), closeFile: async () => {} };
  const controller = createViewerMultiDocumentTabsController({
    state, tabs, lifecycle, render: () => {}, announce: () => {}, showError: (error) => { throw error; },
  });
  const first = await controller.openFile(file('first.pdf'));
  state.zoom = 1.75;
  const second = await controller.openFile(file('second.pdf'));
  assert.equal(tabs.activeTabId, second.id);
  state.zoom = 2;
  await controller.activateTab(first.id);
  assert.equal(state.zoom, 1.75);
  assert.deepEqual(opened, ['first.pdf', 'second.pdf', 'first.pdf']);
});

test('tabs controller suppresses an older activation after completion inversion', async () => {
  const fixture = urls();
  const tabs = createDocumentTabs({ urlApi: fixture.api, maxTabs: 3 });
  const first = await tabs.open(file('first.pdf'));
  const second = await tabs.open(file('second.pdf'));
  const third = await tabs.open(file('third.pdf'));
  tabs.update(first.id, { viewerState: { zoom: 2 } });
  tabs.update(second.id, { viewerState: { zoom: 7 } });
  const pending = new Map();
  const lifecycle = {
    openFile: async (value) => {
      const operation = deferred();
      pending.set(value.name, operation);
      await operation.promise;
    },
    closeFile: async () => {},
  };
  const state = {
    document: { isOpen: true }, zoom: 1, rotation: 0, selectedPage: 1, viewerMode: 'native', searchQuery: '', searchResults: [],
    navigationHistory: [1], navigationIndex: 0,
    controlledRaster: { status: 'idle', page: null, url: null, error: null },
    loupeRaster: { status: 'idle', page: null, url: null, error: null },
  };
  const announcements = [];
  const controller = createViewerMultiDocumentTabsController({
    state, tabs, lifecycle, render: () => {}, announce: (message) => announcements.push(message), showError: (error) => { throw error; },
  });
  const firstActivation = controller.activateTab(first.id);
  const secondActivation = controller.activateTab(second.id);
  pending.get('second.pdf').resolve();
  await secondActivation;
  assert.equal(state.zoom, 7);
  pending.get('first.pdf').resolve();
  await firstActivation;
  assert.equal(state.zoom, 7);
  assert.deepEqual(announcements, ['second.pdf is now active.']);
  assert.equal(tabs.activeTabId, second.id);
  assert.equal(third.name, 'third.pdf');
});

test('tabs controller suppresses an older open after a newer open completes', async () => {
  const fixture = urls();
  const tabs = createDocumentTabs({ urlApi: fixture.api, maxTabs: 3 });
  const pending = new Map();
  const started = new Map();
  const lifecycle = {
    openFile: async (value) => {
      const operation = deferred();
      pending.set(value.name, operation);
      started.get(value.name)?.resolve();
      await operation.promise;
    },
    closeFile: async () => {},
  };
  const state = {
    document: { isOpen: false }, zoom: 1, rotation: 0, selectedPage: 1, viewerMode: 'native', searchQuery: '', searchResults: [],
    navigationHistory: [1], navigationIndex: 0,
    controlledRaster: { status: 'idle', page: null, url: null, error: null },
    loupeRaster: { status: 'idle', page: null, url: null, error: null },
  };
  const announcements = [];
  const controller = createViewerMultiDocumentTabsController({
    state, tabs, lifecycle, render: () => {}, announce: (message) => announcements.push(message), showError: (error) => { throw error; },
  });
  const firstStarted = deferred();
  const secondStarted = deferred();
  started.set('first.pdf', firstStarted);
  started.set('second.pdf', secondStarted);
  const firstOpen = controller.openFile(file('first.pdf'));
  await firstStarted.promise;
  const secondOpen = controller.openFile(file('second.pdf'));
  await secondStarted.promise;
  pending.get('second.pdf').resolve();
  await secondOpen;
  pending.get('first.pdf').resolve();
  await firstOpen;
  assert.deepEqual(announcements, ['second.pdf opened in a local tab.']);
  assert.equal(tabs.state.tabs.at(-1).name, 'second.pdf');
});
