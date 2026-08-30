import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

export const PRODUCTION_ENTRYPOINTS = Object.freeze([
  'src/browser/main.js',
  'src/host/main.mjs',
  'src/cli/main.mjs',
]);

// Keep this exact: every source module must be reachable or deliberately classified.
export const INTENTIONALLY_UNSHIPPED_MODULES = Object.freeze([]);

export const PRODUCTION_SOURCE_ROOTS = Object.freeze([
  Object.freeze({ path: 'src', extensions: Object.freeze(['.js', '.mjs']), language: 'javascript' }),
  Object.freeze({ path: 'native/pdfkit-helper/Sources', extensions: Object.freeze(['.swift']), language: 'swift' }),
]);
const IMPORT_PATTERN = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\()(['"])([^'"]+)\1/gm;

function collectSources(directory, extensions) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSources(path, extensions);
    return entry.isFile() && extensions.has(extname(entry.name)) ? [path] : [];
  });
}

function resolveImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = resolve(dirname(importer), specifier);
  return [candidate, `${candidate}.js`, `${candidate}.mjs`, join(candidate, 'index.js'), join(candidate, 'index.mjs')]
    .find((path) => existsSync(path)) ?? candidate;
}

function dependencies(path) {
  const source = readFileSync(path, 'utf8');
  return [...source.matchAll(IMPORT_PATTERN)]
    .map((match) => resolveImport(path, match[2]))
    .filter(Boolean);
}

export function findReachableModules(graph, entrypoints) {
  const reachable = new Set();
  const pending = [...entrypoints];
  while (pending.length) {
    const path = pending.pop();
    if (reachable.has(path) || !graph.has(path)) continue;
    reachable.add(path);
    pending.push(...graph.get(path));
  }
  return reachable;
}

export function collectProductionSourcePaths(root) {
  return Object.freeze(PRODUCTION_SOURCE_ROOTS.flatMap(({ path, extensions }) => collectSources(
    join(root, path),
    new Set(extensions),
  )).map((path) => relative(root, path)).sort());
}

export function analyzeCurrentSourceReachability(root) {
  const productionSources = collectProductionSourcePaths(root);
  const sourcePaths = productionSources
    .filter((path) => ['.js', '.mjs'].includes(extname(path)))
    .map((path) => join(root, path));
  const nativeSources = productionSources.filter((path) => extname(path) === '.swift');
  const graph = new Map(sourcePaths.map((path) => [path, dependencies(path)]));
  const entrypoints = PRODUCTION_ENTRYPOINTS.map((path) => join(root, path));
  const reachable = findReachableModules(graph, entrypoints);
  const unshipped = new Set(INTENTIONALLY_UNSHIPPED_MODULES);

  const missingEntrypoints = PRODUCTION_ENTRYPOINTS
    .filter((path) => !graph.has(join(root, path))).sort();
  const unresolvedImports = [...graph.entries()].flatMap(([importer, imports]) => imports
    .filter((dependency) => !existsSync(dependency))
    .map((dependency) => `${relative(root, importer)} -> ${relative(root, dependency)}`)).sort();
  const unexpectedUnreachable = sourcePaths
    .filter((path) => !reachable.has(path) && !unshipped.has(relative(root, path)))
    .map((path) => relative(root, path)).sort();
  const staleUnshipped = INTENTIONALLY_UNSHIPPED_MODULES
    .filter((path) => !graph.has(join(root, path)) || reachable.has(join(root, path))).sort();

  return Object.freeze({
    entrypoints: PRODUCTION_ENTRYPOINTS,
    reachable: Object.freeze([...reachable].map((path) => relative(root, path)).sort()),
    productionSources: Object.freeze(productionSources),
    nativeSources: Object.freeze(nativeSources),
    intentionallyUnshipped: INTENTIONALLY_UNSHIPPED_MODULES,
    missingEntrypoints: Object.freeze(missingEntrypoints),
    unresolvedImports: Object.freeze(unresolvedImports),
    unexpectedUnreachable: Object.freeze(unexpectedUnreachable),
    staleUnshipped: Object.freeze(staleUnshipped),
  });
}

export function assertCurrentSourceReachability(root) {
  const result = analyzeCurrentSourceReachability(root);
  const failures = [
    ['Missing production entrypoints', result.missingEntrypoints],
    ['Unresolved relative imports', result.unresolvedImports],
    ['Unexpected unreachable production modules', result.unexpectedUnreachable],
    ['Stale intentionally-unshipped classifications', result.staleUnshipped],
  ].filter(([, paths]) => paths.length);
  if (failures.length) {
    const error = new Error(failures.map(([label, paths]) => `${label}:\n${paths.join('\n')}`).join('\n'));
    error.code = 'SOURCE_REACHABILITY_FAILED';
    throw error;
  }
  return result;
}
