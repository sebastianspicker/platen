import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationPresentation, replaceRenderedMarkup } from '../src/bootstrap/application-presentation.js';

function element(localName, attributes = {}) {
  const values = new Map(Object.entries(attributes));
  return {
    localName,
    removed: false,
    get attributes() { return [...values].map(([name, value]) => ({ name, value })); },
    remove() { this.removed = true; },
    removeAttribute(name) { values.delete(name); },
    getAttribute(name) { return values.get(name) ?? null; },
  };
}

function withFakeDomParser(t, parser) {
  const previous = globalThis.DOMParser;
  globalThis.DOMParser = parser;
  t.after(() => {
    if (previous === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = previous;
  });
}

function rootFor(nodes) {
  const root = {
    ownerDocument: {
      defaultView: { DOMParser: globalThis.DOMParser },
      importNode(node) { return node; },
    },
    rendered: [],
    contains() { return false; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    setAttribute() {},
    replaceChildren(...next) { this.rendered = next; },
  };
  return { root, nodes };
}

test('presentation treats hostile state as text while rendering the normal editor shell', (t) => {
  const parsedNodes = [element('div', { class: 'app-shell trust-shell' })];
  let receivedMarkup = '';
  class FakeDOMParser {
    parseFromString(markup) {
      receivedMarkup = markup;
      return {
        querySelectorAll() { return []; },
        body: { childNodes: parsedNodes, querySelectorAll() { return parsedNodes; } },
      };
    }
  }
  withFakeDomParser(t, FakeDOMParser);
  const { root } = rootFor(parsedNodes);
  const workspace = { focusCalls: 0, focus() { this.focusCalls += 1; } };
  root.querySelector = (selector) => selector === '#workspace' ? workspace : null;
  root.scrollTop = 18;
  root.scrollLeft = 4;
  const hostileName = '<img src=x onerror="globalThis.presentationXss = true">';
  const state = {
    registry: {}, view: 'trust', document: { isOpen: true, name: hostileName, size: 0, type: null, objectUrl: null, modified: false },
    summary: { planned: 0 }, zoom: 1, rotation: 0, dragging: false, error: null,
  };
  createApplicationPresentation({ root, liveRegion: { textContent: '' }, state, session: {} }).render();
  assert.match(receivedMarkup, /<main class="trust-workspace" id="workspace"/u);
  assert.match(receivedMarkup, /&lt;img src=x onerror=&quot;globalThis\.presentationXss = true&quot;&gt;/u);
  assert.doesNotMatch(receivedMarkup, /<img src=x onerror=/u);
  assert.equal(root.rendered[0]?.localName, 'div');
  assert.equal(workspace.focusCalls, 1);
  assert.equal(root.scrollTop, 18);
  assert.equal(root.scrollLeft, 4);
  assert.equal(globalThis.presentationXss, undefined);
});

test('presentation removes executable markup and URLs before connecting rendered nodes', (t) => {
  const safe = element('main', { id: 'workspace' });
  const preview = element('img', { src: 'data:image/png;base64,iVBORw0KGgo=' });
  const image = element('img', { src: 'javascript:alert(1)', onerror: 'globalThis.presentationXss = true' });
  const script = element('script');
  const iframe = element('iframe', { srcdoc: '<script>globalThis.presentationXss = true</script>' });
  const nodes = [safe, preview, image, script, iframe];
  class FakeDOMParser {
    parseFromString() {
      return {
        querySelectorAll() { return [script, iframe]; },
        body: {
          get childNodes() { return nodes.filter((node) => !node.removed); },
          querySelectorAll() { return nodes.filter((node) => !node.removed); },
        },
      };
    }
  }
  withFakeDomParser(t, FakeDOMParser);
  const { root } = rootFor(nodes);
  replaceRenderedMarkup(root, '<main id="workspace"></main><img src="javascript:alert(1)" onerror="globalThis.presentationXss = true"><script>globalThis.presentationXss = true</script>');
  assert.deepEqual(root.rendered, [safe, preview, image]);
  assert.equal(preview.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(image.getAttribute('src'), null);
  assert.equal(image.getAttribute('onerror'), null);
  assert.equal(script.removed, true);
  assert.equal(iframe.removed, true);
  assert.equal(globalThis.presentationXss, undefined);
});
