import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

test('CI covers pushes, pull requests, supported Node, and native Swift gates', () => {
  assert.match(workflow, /^on:\n  push:\n  pull_request:$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /node-version: \['20', '24'\]/);
  assert.match(workflow, /runs-on: macos-15/);
  assert.equal(workflow.match(/uses: actions\/checkout@v7/g)?.length, 2);
  assert.equal(workflow.match(/uses: actions\/setup-node@v7/g)?.length, 2);
  assert.equal(workflow.match(/run: npm run verify/g)?.length, 2);
  assert.match(workflow, /run: npm run release:validate/);
  assert.match(workflow, /run: swift test --package-path native\/pdfkit-helper/);
  assert.match(workflow, /run: swift test --package-path native\/plugin-worker/);
  assert.doesNotMatch(workflow, /^verification:/m);
});
