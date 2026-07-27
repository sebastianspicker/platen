import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplicationPresentation } from '../src/bootstrap/application-presentation.js';
import { brandAndMenu, errorBanner, rail } from '../src/ui/shared.js';
import { state } from './support/view-render-fixture.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

test('shell keeps route context separate from the complete application rail', () => {
  const header = brandAndMenu('workflows');
  assert.match(header, /Platen<span>The local-first PDF workbench\.<\/span>/);
  assert.match(header, /class="route-context"/);
  assert.match(header, />Operations</);
  assert.doesNotMatch(header, /<nav/);
  const workflowRail = rail('workflows');
  for (const label of ['Workspace', 'Operations', 'Coverage', 'Trust']) {
    assert.match(workflowRail, new RegExp(`>${label}<`));
  }
  assert.match(workflowRail, /<nav class="tool-rail" aria-label="Application">/);
  assert.equal((workflowRail.match(/is-selected/g) ?? []).length, 1);
  assert.doesNotMatch(workflowRail, /disabled/);
  assert.doesNotMatch(workflowRail, />Pages</);
});

test('shell loading, error, and live-message contracts are explicit', () => {
  const html = read('index.html');
  assert.match(html, /<title>Platen<\/title>/);
  assert.match(html, /content="The local-first PDF workbench\."/);
  assert.match(html, /class="initial-loading"/);
  assert.match(html, /Loading local workspace…/);
  assert.match(html, /id="live-region" class="sr-only" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(errorBanner('Local failure'), /id="error-banner"[^>]*role="alert"[^>]*tabindex="-1"/);
  assert.match(errorBanner('Local failure'), /data-action="dismiss-error"/);
});

test('responsive shell preserves navigation and mobile page access', () => {
  const responsive = `${read('styles/responsive.css')}\n${read('styles/mobile.css')}`;
  const css = `${read('styles/foundation.css')}\n${read('styles/shell.css')}\n${responsive}`;
  assert.match(css, /100dvh/);
  assert.match(responsive, /\.pages-panel\s*\{\s*display:\s*none;/);
  assert.match(css, /\.toolbar-label[\s\S]*clip:\s*rect/);
  assert.match(responsive, /\.tool-rail\s*\{[^}]*position:\s*absolute/s);
});

test('error banner stays visible above clipped shell layouts', () => {
  const css = read('styles/shell-feedback.css');
  assert.match(read('styles/app.css'), /@import url\("\.\/shell-feedback\.css"\);/);
  assert.match(css, /\.error-banner\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.error-banner\s*\{[^}]*max-height:\s*min\(50dvh, 360px\)/s);
  assert.match(css, /\.error-banner \.icon-button:focus-visible/);
});

test('presentation captures and restores focus, caret, and scroll state', () => {
  const source = read('src/bootstrap/application-presentation.js');
  for (const token of ['selectionStart', 'setSelectionRange', 'scrollTop', 'aria-busy'] ) {
    assert.match(source, new RegExp(token));
  }
});

function scrollTree(rootNode, offsets) {
  const container = { children: [], parentElement: rootNode };
  const panels = offsets.map(({ top, left }) => ({
    id: '', className: 'panel-content', children: [], parentElement: container,
    scrollTop: top, scrollLeft: left,
  }));
  container.children = panels;
  return { container, panels };
}

function rerenderRoot(active, replacement, activeTab = null) {
  const replacements = Array.isArray(replacement) ? replacement : [replacement];
  let rendered = false;
  const workspace = { focused: false, focus() { this.focused = true; } };
  const appRoot = {
    children: [active], scrollTop: 0, scrollLeft: 0,
    ownerDocument: { activeElement: active },
    contains: (node) => node === active,
    setAttribute() {},
    querySelectorAll: () => rendered ? replacements : [active],
    querySelector: (selector) => {
      if (selector === '[role="tab"][aria-selected="true"]') return activeTab;
      if (selector === '#workspace') return workspace;
      return null;
    },
  };
  active.parentElement = appRoot;
  for (const node of replacements) node.parentElement = appRoot;
  Object.defineProperty(appRoot, 'innerHTML', {
    set() {
      rendered = true;
      appRoot.children = replacements;
    },
  });
  return { appRoot, workspace };
}

test('presentation restores same-class scroll containers independently', () => {
  let tree;
  const workspace = { focus() {} };
  const appRoot = {
    children: [], scrollTop: 0, scrollLeft: 0,
    ownerDocument: { activeElement: null },
    contains: () => false,
    setAttribute() {},
    querySelectorAll: () => tree.panels,
    querySelector: (selector) => selector === '#workspace' ? workspace : null,
  };
  tree = scrollTree(appRoot, [{ top: 31, left: 7 }, { top: 79, left: 13 }]);
  appRoot.children = [tree.container];
  Object.defineProperty(appRoot, 'innerHTML', {
    set() {
      tree = scrollTree(appRoot, [{ top: 0, left: 0 }, { top: 0, left: 0 }]);
      appRoot.children = [tree.container];
    },
  });

  createApplicationPresentation({ root: appRoot, liveRegion: { textContent: '' }, state: state(), session: {} }).render();

  assert.deepEqual(tree.panels.map(({ scrollTop, scrollLeft }) => [scrollTop, scrollLeft]), [[31, 7], [79, 13]]);
});

test('presentation does not transfer scroll offsets between different route layouts', () => {
  let rendered = false;
  let currentPanels = [{
    id: '', className: 'plugin-list-panel', children: [], scrollTop: 88, scrollLeft: 14,
  }];
  const workspace = { focus() {} };
  const appRoot = {
    children: [], scrollTop: 0, scrollLeft: 0,
    ownerDocument: { activeElement: null },
    contains: () => false,
    setAttribute() {},
    querySelectorAll: () => currentPanels,
    querySelector: (selector) => selector === '#workspace' ? workspace : null,
  };
  currentPanels[0].parentElement = appRoot;
  Object.defineProperty(appRoot, 'innerHTML', {
    set() {
      if (!rendered) {
        rendered = true;
        return;
      }
      currentPanels = [{
        id: '', className: 'trust-content', children: [], parentElement: appRoot,
        scrollTop: 0, scrollLeft: 0,
      }];
    },
  });
  const appState = state({ view: 'plugins' });
  const presentation = createApplicationPresentation({
    root: appRoot, liveRegion: { textContent: '' }, state: appState, session: {},
  });
  presentation.render();
  appState.view = 'trust';
  presentation.render();

  assert.equal(currentPanels[0].scrollTop, 0);
  assert.equal(currentPanels[0].scrollLeft, 0);
});

test('presentation restores focus to controls identified only by route data', () => {
  const active = {
    id: '', dataset: { domainGroup: 'review', domainOperation: 'createAnnotation' },
    children: [], scrollTop: 0, scrollLeft: 0,
  };
  const replacement = {
    ...active, dataset: { ...active.dataset }, focused: false,
    focus() { this.focused = true; },
  };
  const { appRoot } = rerenderRoot(active, replacement);

  createApplicationPresentation({ root: appRoot, liveRegion: { textContent: '' }, state: state(), session: {} }).render();

  assert.equal(replacement.focused, true);
});

test('presentation redirects transient file-picker focus to the active document tab', () => {
  const filePicker = { id: 'file-picker', dataset: {}, children: [], scrollTop: 0, scrollLeft: 0 };
  const replacement = { id: 'file-picker', dataset: {}, children: [], scrollTop: 0, scrollLeft: 0 };
  const activeTab = { focused: false, focus() { this.focused = true; } };
  const { appRoot, workspace } = rerenderRoot(filePicker, replacement, activeTab);

  createApplicationPresentation({ root: appRoot, liveRegion: { textContent: '' }, state: state(), session: {} }).render();

  assert.equal(activeTab.focused, true);
  assert.equal(workspace.focused, false);
});

test('page navigation focus follows the enabled semantic control when its target changes', () => {
  const previous = {
    id: '', dataset: { pageDirection: 'previous', pageNumber: '1' },
    children: [], scrollTop: 0, scrollLeft: 0, disabled: false,
  };
  const disabledPrevious = {
    id: '', dataset: { pageDirection: 'previous' },
    children: [], scrollTop: 0, scrollLeft: 0, disabled: true,
    focused: false, focus() { this.focused = true; },
  };
  const enabledNext = {
    id: '', dataset: { pageDirection: 'next', pageNumber: '2' },
    children: [], scrollTop: 0, scrollLeft: 0, disabled: false,
    focused: false, focus() { this.focused = true; },
  };
  const { appRoot, workspace } = rerenderRoot(previous, [disabledPrevious, enabledNext]);

  createApplicationPresentation({ root: appRoot, liveRegion: { textContent: '' }, state: state(), session: {} }).render();

  assert.equal(disabledPrevious.focused, false);
  assert.equal(enabledNext.focused, true);
  assert.equal(workspace.focused, false);
});
