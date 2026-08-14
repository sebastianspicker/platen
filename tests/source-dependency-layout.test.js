import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const productionRoots = ['src', 'scripts'];
const sourceExtensions = new Set(['.js', '.mjs']);
const facadePath = join(root, 'scripts/host/pdf-service.mjs');
const facadeImportAllowlist = new Set([join(root, 'scripts/local-host.mjs')]);
const comparisonFacadePath = join(root, 'scripts/host/comparison-service.mjs');
const comparisonFacadeImportAllowlist = new Set([join(root, 'scripts/local-host.mjs')]);
const conversionRuntimePath = join(root, 'scripts/host/conversion-job-runtime.mjs');
const workspaceRuntimePath = join(root, 'scripts/host/workspace-job-runtime.mjs');
const importPattern = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\()(['"])([^'"]+)\1/gmu;

function collectSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSources(path);
    return entry.isFile() && sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

function resolveImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = resolve(dirname(importer), specifier);
  for (const path of [candidate, `${candidate}.js`, `${candidate}.mjs`, join(candidate, 'index.js')]) {
    if (existsSync(path)) return path;
  }
  return candidate;
}

function dependencies(path) {
  const source = readFileSync(path, 'utf8');
  return [...source.matchAll(importPattern)]
    .map((match) => resolveImport(path, match[2]))
    .filter(Boolean);
}

function findCycles(graph) {
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const cycles = [];
  function visit(path) {
    if (active.has(path)) {
      const start = stack.indexOf(path);
      cycles.push([...stack.slice(start), path].map((entry) => relative(root, entry)));
      return;
    }
    if (visited.has(path)) return;
    visited.add(path);
    active.add(path);
    stack.push(path);
    for (const dependency of graph.get(path) ?? []) {
      if (graph.has(dependency)) visit(dependency);
    }
    stack.pop();
    active.delete(path);
  }
  for (const path of graph.keys()) visit(path);
  return cycles;
}

test('production module graph resolves, stays acyclic, and keeps service facades at composition roots', () => {
  const sources = productionRoots.flatMap((path) => collectSources(join(root, path)));
  const graph = new Map(sources.map((path) => [path, dependencies(path)]));
  const unresolved = [...graph.entries()].flatMap(([importer, imports]) => imports
    .filter((dependency) => !existsSync(dependency))
    .map((dependency) => `${relative(root, importer)} -> ${relative(root, dependency)}`));
  const forbiddenFacadeImports = [...graph.entries()]
    .filter(([importer, imports]) => imports.includes(facadePath) && !facadeImportAllowlist.has(importer))
    .map(([importer]) => relative(root, importer));
  const forbiddenComparisonFacadeImports = [...graph.entries()]
    .filter(([importer, imports]) => imports.includes(comparisonFacadePath)
      && !comparisonFacadeImportAllowlist.has(importer))
    .map(([importer]) => relative(root, importer));

  assert.deepEqual(unresolved, [], `Unresolved relative imports:\n${unresolved.join('\n')}`);
  assert.deepEqual(findCycles(graph), [], 'Production imports must remain acyclic.');
  assert.deepEqual(
    forbiddenFacadeImports,
    [],
    'Only a composition root may import the PdfService compatibility facade.',
  );
  assert.deepEqual(
    forbiddenComparisonFacadeImports,
    [],
    'Only a composition root may import the ComparisonService coordinator facade.',
  );
  assert.ok(
    graph.get(conversionRuntimePath)?.includes(workspaceRuntimePath),
    'Conversion jobs must reuse the shared deadline and workspace-quota runtime.',
  );
});
