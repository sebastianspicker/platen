import assert from 'node:assert/strict';
import test from 'node:test';
import { startApplication } from '../src/bootstrap/application-bootstrap.js';

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    contains() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    focus() {},
    innerHTML: '',
  };
}

test('application bootstrap wires document operation callbacks before creating browser controllers', () => {
  const root = eventTarget();
  const liveRegion = { textContent: '' };
  const documentApi = eventTarget();
  documentApi.documentElement = { lang: 'en' };
  documentApi.querySelector = (selector) => (
    selector === '#app' ? root : selector === '#live-region' ? liveRegion : null
  );

  const windowApi = eventTarget();
  windowApi.confirm = () => false;

  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  globalThis.document = documentApi;
  globalThis.window = windowApi;
  globalThis.fetch = async () => new Response('', { status: 503 });

  try {
    assert.doesNotThrow(() => startApplication(documentApi));
    assert.equal(root.listeners.has('click'), true);
    assert.equal(root.listeners.has('change'), true);
    assert.equal(root.listeners.has('dragenter'), true);
  } finally {
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
    if (previous.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous.fetch;
  }
});
