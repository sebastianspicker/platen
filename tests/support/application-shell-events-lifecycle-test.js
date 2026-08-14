import assert from 'node:assert/strict';
import test from 'node:test';
import { bindApplicationShellEvents } from '../../src/ui/application-shell-events.js';

function shellEventTarget(name, contains = () => false, listenerLog = []) {
  const listeners = new Map();
  return {
    name,
    listeners,
    contains,
    addEventListener(eventName, listener, options) {
      listenerLog.push(['add', name, eventName, listener, options]);
      listeners.set(eventName, listener);
    },
    removeEventListener(eventName, listener, options) {
      listenerLog.push(['remove', name, eventName, listener, options]);
      if (listeners.get(eventName) === listener) listeners.delete(eventName);
    },
  };
}

function preventedEvent(overrides = {}) {
  return { preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false, ...overrides };
}

function createShellLifecycleFixture() {
  const listenerLog = [];
  const root = shellEventTarget('root', (target) => target === 'inside-root', listenerLog);
  const windowApi = shellEventTarget('window', () => false, listenerLog);
  const documentApi = shellEventTarget('document', () => false, listenerLog);
  const calls = [];
  const elements = { '#file-picker': { click: () => calls.push('picker-click') }, '#document-search': { focus: () => calls.push('search-focus') } };
  documentApi.querySelector = (selector) => elements[selector] ?? null;
  documentApi.querySelectorAll = () => [
    { dataset: { tabId: 'first' }, focus: () => calls.push('focus-first') },
    { dataset: { tabId: 'second' }, focus: () => calls.push('focus-second') },
    { dataset: { tabId: 'third' }, focus: () => calls.push('focus-third') },
  ];
  const snapshots = [];
  let unsubscribeCalls = 0;
  const state = { dragging: false, presentationMode: true, analysis: { textPages: ['searchable'] }, documentTabs: { tabs: [{ id: 'first' }, { id: 'second' }, { id: 'third' }] } };
  const tabs = { openFile: (file) => calls.push(['open-file', file.name]), activateTab: (id) => calls.push(['activate-tab', id]), dispose: () => calls.push('tabs-dispose') };
  const unbind = bindApplicationShellEvents({
    root, state,
    session: { subscribe(listener) { calls.push('subscribe'); listener({ id: 'initial-document' }); snapshots.push(listener); return () => { unsubscribeCalls += 1; }; } },
    lifecycle: { openFile: (file) => calls.push(['lifecycle-open-file', file.name]), dispose: () => calls.push('lifecycle-dispose') },
    tabs, generation: { convertLocalFile: (file) => calls.push(['convert-file', file.name]) },
    document: documentApi, window: windowApi, render: () => calls.push('render'),
  });
  return { calls, documentApi, listenerLog, root, snapshots, state, unbind, unsubscribeCalls: () => unsubscribeCalls, windowApi };
}

function assertRegistration(fixture) {
  const { calls, listenerLog, state } = fixture;
  assert.deepEqual(listenerLog.map(([operation, target, eventName, , options]) => [operation, target, eventName, options]), [
    ['add', 'root', 'dragenter', undefined], ['add', 'root', 'dragover', undefined], ['add', 'root', 'dragleave', undefined], ['add', 'root', 'drop', undefined],
    ['add', 'window', 'keydown', undefined], ['add', 'window', 'beforeunload', undefined], ['add', 'document', 'fullscreenchange', undefined],
  ]);
  assert.deepEqual(calls, ['subscribe']);
  assert.deepEqual(state.document, { id: 'initial-document' });
}

function assertDragAndDropRouting({ calls, root, state }) {
  const dragEnter = preventedEvent();
  root.listeners.get('dragenter')(dragEnter); root.listeners.get('dragover')(preventedEvent());
  assert.equal(dragEnter.defaultPrevented, true); assert.equal(state.dragging, true); assert.deepEqual(calls, ['subscribe', 'render']);
  root.listeners.get('dragleave')({ relatedTarget: 'inside-root' }); assert.equal(state.dragging, true);
  root.listeners.get('dragleave')({ relatedTarget: null }); assert.equal(state.dragging, false);
  const pdfDrop = preventedEvent({ dataTransfer: { files: [{ name: 'report.pdf', type: 'application/pdf' }] } });
  root.listeners.get('drop')(pdfDrop);
  root.listeners.get('drop')(preventedEvent({ dataTransfer: { files: [{ name: 'report.PDF', type: 'text/plain' }] } }));
  root.listeners.get('drop')(preventedEvent({ dataTransfer: { files: [{ name: 'notes.txt', type: 'text/plain' }] } }));
  root.listeners.get('drop')(preventedEvent({ dataTransfer: { files: [] } }));
  assert.equal(pdfDrop.defaultPrevented, true);
  assert.deepEqual(calls.slice(-4), [['open-file', 'report.pdf'], ['open-file', 'report.PDF'], ['convert-file', 'notes.txt'], 'render']);
}

function assertKeyboardRouting({ calls, state, windowApi }) {
  const tabTarget = { dataset: { tabId: 'second' }, closest: () => tabTarget };
  const events = ['ArrowLeft', 'End', 'ArrowRight', 'Home'].map((key) => preventedEvent({ key, target: tabTarget }));
  for (const event of events) windowApi.listeners.get('keydown')(event);
  assert.equal(events.every(({ defaultPrevented }) => defaultPrevented), true);
  assert.deepEqual(calls.slice(-8), ['focus-first', ['activate-tab', 'first'], 'focus-third', ['activate-tab', 'third'], 'focus-third', ['activate-tab', 'third'], 'focus-first', ['activate-tab', 'first']]);
  const open = preventedEvent({ key: 'O', metaKey: true, target: { closest: () => null } });
  const search = preventedEvent({ key: 'f', ctrlKey: true, target: { closest: () => null } });
  const ordinary = preventedEvent({ key: 'x', target: { closest: () => null } });
  const unavailableSearch = preventedEvent({ key: 'f', ctrlKey: true, target: { closest: () => null } });
  windowApi.listeners.get('keydown')(open); windowApi.listeners.get('keydown')(search); windowApi.listeners.get('keydown')(ordinary);
  state.analysis.textPages = []; windowApi.listeners.get('keydown')(unavailableSearch);
  assert.equal(open.defaultPrevented, true); assert.equal(search.defaultPrevented, true);
  assert.equal(ordinary.defaultPrevented, false); assert.equal(unavailableSearch.defaultPrevented, false);
  assert.deepEqual(calls.slice(-2), ['picker-click', 'search-focus']);
}

function assertTeardown(fixture) {
  const { calls, documentApi, listenerLog, root, snapshots, state, unbind, unsubscribeCalls, windowApi } = fixture;
  documentApi.fullscreenElement = {}; documentApi.listeners.get('fullscreenchange')(); assert.equal(state.presentationMode, true);
  documentApi.fullscreenElement = null; documentApi.listeners.get('fullscreenchange')(); assert.equal(state.presentationMode, false);
  windowApi.listeners.get('beforeunload')(); assert.deepEqual(calls.slice(-3), ['render', 'lifecycle-dispose', 'tabs-dispose']);
  snapshots[0]({ id: 'updated-document' }); assert.deepEqual(state.document, { id: 'updated-document' });
  unbind(); assert.equal(unsubscribeCalls(), 1);
  assert.deepEqual(listenerLog.slice(7).map(([, , , listener]) => listener), listenerLog.slice(0, 7).map(([, , , listener]) => listener));
  assert.deepEqual(listenerLog.map(([operation, target, eventName, , options]) => [operation, target, eventName, options]), [
    ['add', 'root', 'dragenter', undefined], ['add', 'root', 'dragover', undefined], ['add', 'root', 'dragleave', undefined], ['add', 'root', 'drop', undefined], ['add', 'window', 'keydown', undefined], ['add', 'window', 'beforeunload', undefined], ['add', 'document', 'fullscreenchange', undefined],
    ['remove', 'root', 'dragenter', undefined], ['remove', 'root', 'dragover', undefined], ['remove', 'root', 'dragleave', undefined], ['remove', 'root', 'drop', undefined], ['remove', 'window', 'keydown', undefined], ['remove', 'window', 'beforeunload', undefined], ['remove', 'document', 'fullscreenchange', undefined],
  ]);
  assert.equal(root.listeners.size, 0); assert.equal(windowApi.listeners.size, 0); assert.equal(documentApi.listeners.size, 0);
}

export function registerApplicationShellEventsLifecycleTest() {
  test('application shell events preserve listener lifecycle and browser event routing', () => {
    const fixture = createShellLifecycleFixture();
    assertRegistration(fixture);
    assertDragAndDropRouting(fixture);
    assertKeyboardRouting(fixture);
    assertTeardown(fixture);
  });
}
