import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { relative, resolve, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  collectProductionSources,
  measureSourceSymbols,
  sourceSymbolMetrics,
} from '../../tools/analysis/source-symbol-metrics.mjs';
import { analyzeCurrentSourceReachability } from '../../tools/analysis/source-module-reachability.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('source symbol analysis ignores comments, strings, and regular expressions', () => {
  const metrics = measureSourceSymbols([
    '// function ignored() {}',
    "const message = 'function ignoredAgain() {}';",
    'const pattern = /function ignoredOnceMore\\(\\) \\{\\}/;',
    "const markup = `<section>${items.map((item) => `<div class=\"card\">${item}</div>`).join('')}</section>`;",
    'export function useful(value) {',
    '  if (value) return { value };',
    '  return null;',
    '}',
  ].join('\n'));

  assert.deepEqual(metrics, [{
    kind: 'function',
    name: 'useful',
    startLine: 5,
    endLine: 8,
    lines: 4,
  }]);
});

test('production source analysis uses declared roots and reports structurally valid symbols', () => {
  const sourcePaths = collectProductionSources(repositoryRoot);
  assert.ok(sourcePaths.length > 0, 'Expected production source roots to contain analyzable source files.');

  for (const path of sourcePaths) {
    const sourceLineCount = readFileSync(path, 'utf8').split('\n').length;
    for (const metric of sourceSymbolMetrics(path)) {
      assert.ok(metric.startLine >= 1 && metric.endLine >= metric.startLine);
      assert.ok(metric.endLine <= sourceLineCount, `${relative(repositoryRoot, path)} ${metric.name} has invalid source bounds.`);
    }
  }
});

test('production reachability reports unclassified unreachable source', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-source-layout-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, 'src/browser'), { recursive: true }),
    mkdir(join(root, 'src/host'), { recursive: true }),
    mkdir(join(root, 'src/cli'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'src/browser/main.js'), "import '../shared.js';\n"),
    writeFile(join(root, 'src/host/main.mjs'), ''),
    writeFile(join(root, 'src/cli/main.mjs'), ''),
    writeFile(join(root, 'src/shared.js'), 'export const shared = true;\n'),
    writeFile(join(root, 'src/unclassified.mjs'), 'export const unused = true;\n'),
  ]);

  const reachability = analyzeCurrentSourceReachability(root);
  assert.deepEqual(reachability.missingEntrypoints, []);
  assert.deepEqual(reachability.unresolvedImports, []);
  assert.deepEqual(reachability.unexpectedUnreachable, ['src/unclassified.mjs']);
  assert.deepEqual(reachability.staleUnshipped, []);
});
