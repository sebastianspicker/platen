import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rail } from '../src/ui/shared.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const editorSources = () => [
  'src/ui/editor-inspector/index.js',
  'src/ui/editor-inspector/document-panel.js',
  'src/ui/editor-inspector/pdfkit-sections.js',
  'src/ui/editor-inspector/surface-panels.js',
].map(read).join('\n');

test('shell has a restrictive local CSP and semantic status surfaces', () => {
  const html = read('index.html');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /object-src 'self' blob:/);
  assert.match(html, /frame-src blob:/);
  assert.doesNotMatch(html, /frame-src (?:'self'|https?:)/);
  assert.doesNotMatch(html, /<script[^>]+https?:\/\//i);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /href="#workspace"/);
});

test('shell remains dependency-free and loads local source files only', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies, {});
  assert.deepEqual(pkg.devDependencies, {});
  assert.match(read('src/bootstrap/application-bootstrap.js'), /DocumentSession/);
  assert.match(editorSources(), /Download original/);
  assert.match(read('src/core/plugin-host.js'), /PLUGIN_EXECUTION_REQUIREMENTS/);
  assert.match(read('src/core/plugin-host.js'), /osSandbox/);
  assert.doesNotMatch(read('src/core/plugin-host.js'), /allow-scripts/);
  assert.doesNotMatch(read('src/app.js'), /https?:\/\//);
});

test('task-first shell removes disabled editing clutter while keeping advanced capabilities discoverable', () => {
  const editor = editorSources();
  const plugins = read('src/ui/plugins-view.js');
  const shell = read('src/ui/shared.js');
  const navigation = rail('editor');
  assert.doesNotMatch(editor, /needs a plugin engine/);
  assert.doesNotMatch(shell, /disabled[^>]*>\s*Edit\s*</);
  assert.match(navigation, /data-action="show-plugins"[^>]*>[\s\S]*?<span>Coverage<\/span><\/button>/);
  assert.match(navigation, /data-action="show-about"[^>]*>[\s\S]*?<span>Trust<\/span><\/button>/);
  assert.match(plugins, /Engine required/);
  assert.match(plugins, /Install unavailable/);
  assert.match(plugins, /Non-executable plugin skeleton/);
  assert.match(read('src/bootstrap/application-presentation.js'), /state\.view === 'trust'/);
  assert.match(read('src/ui/application-click-view-actions.js'), /'show-about': \(\) => viewer\.setView\('trust'\)/);
  assert.match(read('src/ui/trust-view.js'), /Trust &amp; limits/);
});
