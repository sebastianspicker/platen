import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('static demo is a self-contained fixture with no file or network boundary', () => {
  const html = read('demo/index.html');
  const app = read('demo/app.js');

  assert.match(html, /<link rel="stylesheet" href="styles\.css" \/>/);
  assert.match(html, /<script src="app\.js"><\/script>/);
  assert.match(html, /Static demo<\/strong>/);
  assert.match(html, /This page processes no files, stores no documents, and produces no output\./);
  assert.doesNotMatch(html, /<form\b|type="file"|\saction\s*=/i);
  assert.doesNotMatch(app, /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|document\.cookie|createObjectURL)\b/);
});

test('Pages workflow deploys only the static demo after an explicit GitHub trigger', () => {
  const workflow = read('.github/workflows/pages.yml');

  assert.match(workflow, /^on:\n  push:\n    branches: \[main\]\n  workflow_dispatch:$/m);
  assert.match(workflow, /^permissions:\n  contents: read\n  pages: write\n  id-token: write$/m);
  assert.match(workflow, /uses: actions\/configure-pages@v5/);
  assert.match(workflow, /uses: actions\/upload-pages-artifact@v4\n        with:\n          path: demo/);
  assert.match(workflow, /uses: actions\/deploy-pages@v4/);
});

test('release documentation does not present an unrun Pages deployment as live', () => {
  const readme = read('README.md');
  const status = read('RELEASE_STATUS.md');
  const releasing = read('docs/RELEASING.md');

  assert.match(readme, /expected future URL, not a\nverified live demo/);
  assert.doesNotMatch(readme, /\[Open the static demo\]\(https:\/\/sebastianspicker\.github\.io\/platen\/\)/);
  assert.match(status, /have not been pushed or run/);
  assert.match(releasing, /npm run check:professional-clones/);
});
