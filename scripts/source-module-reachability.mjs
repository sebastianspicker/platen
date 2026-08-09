import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

export const PRODUCTION_ENTRYPOINTS = Object.freeze([
  'src/app.js',
  'scripts/serve.mjs',
  'scripts/platen-cli.mjs',
]);

// These modules are deliberately shipped as reviewed source foundations, but no
// production entrypoint may execute them until the documented plugin release
// controls exist. Keep this exact: a new disconnected module must be classified.
export const INTENTIONALLY_UNSHIPPED_MODULES = Object.freeze([
  'src/core/permissions.js',
  'src/core/plugin-host.js',
  'src/core/plugin-protocol.js',
  'src/core/validate.js',
  'scripts/host/domains/aec-collaboration.mjs',
  'scripts/host/domains/trust-accessibility.mjs',
  'scripts/host/plugin-document-handle-source.mjs',
  'scripts/host/plugin-document-handles.mjs',
  'scripts/host/plugin-frame-stream.mjs',
  'scripts/host/plugin-grants.mjs',
  'scripts/host/plugin-native-code-identity.mjs',
  'scripts/host/plugin-native-deadline.mjs',
  'scripts/host/plugin-native-frame-inbox.mjs',
  'scripts/host/plugin-native-process-group.mjs',
  'scripts/host/plugin-native-runtime.mjs',
  'scripts/host/plugin-native-supervisor-contract.mjs',
  'scripts/host/plugin-native-supervisor-loader.mjs',
  'scripts/host/plugin-native-supervisor-process.mjs',
  'scripts/host/plugin-native-supervisor.mjs',
  'scripts/host/plugin-operation-session-lifecycle.mjs',
  'scripts/host/plugin-operation-session.mjs',
  'scripts/host/plugin-rpc-broker.mjs',
  'scripts/host/plugin-rpc-transport-runtime.mjs',
  'scripts/host/plugin-rpc-transport-setup.mjs',
  'scripts/host/plugin-rpc-transport.mjs',
  'scripts/host/plugin-runtime-gate.mjs',
  'scripts/host/plugin-worker-control.mjs',
]);

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs']);
const NATIVE_SOURCE_ROOTS = Object.freeze([
  'native/pdfkit-helper/Sources',
  'native/plugin-worker/Sources',
]);
const IMPORT_PATTERN = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\()(['"])([^'"]+)\1/gm;

function collectSources(directory, extensions = SOURCE_EXTENSIONS) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSources(path, extensions);
    return entry.isFile() && extensions.has(extname(entry.name)) ? [path] : [];
  });
}

function resolveImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = resolve(dirname(importer), specifier);
  return [candidate, `${candidate}.js`, `${candidate}.mjs`, join(candidate, 'index.js')]
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

export function analyzeCurrentSourceReachability(root, requiredPaths) {
  const sourcePaths = [join(root, 'src'), join(root, 'scripts')]
    .flatMap((directory) => collectSources(directory));
  const nativeSourcePaths = NATIVE_SOURCE_ROOTS
    .flatMap((directory) => collectSources(join(root, directory), new Set(['.swift'])));
  const graph = new Map(sourcePaths.map((path) => [path, dependencies(path)]));
  const entrypoints = PRODUCTION_ENTRYPOINTS.map((path) => join(root, path));
  const reachable = findReachableModules(graph, entrypoints);
  const relativeSources = sourcePaths.map((path) => relative(root, path)).sort();
  const productionCandidates = sourcePaths.filter((path) => {
    const name = relative(root, path);
    return name.startsWith('src/') || name.startsWith('scripts/host/')
      || PRODUCTION_ENTRYPOINTS.includes(name);
  });
  const unshipped = new Set(INTENTIONALLY_UNSHIPPED_MODULES);
  const required = new Set(requiredPaths);

  const unresolvedImports = [...graph.entries()].flatMap(([importer, imports]) => imports
    .filter((dependency) => !existsSync(dependency))
    .map((dependency) => `${relative(root, importer)} -> ${relative(root, dependency)}`)).sort();
  const unexpectedUnreachable = productionCandidates
    .filter((path) => !reachable.has(path) && !unshipped.has(relative(root, path)))
    .map((path) => relative(root, path)).sort();
  const staleUnshipped = INTENTIONALLY_UNSHIPPED_MODULES
    .filter((path) => !graph.has(join(root, path)) || reachable.has(join(root, path))).sort();
  const nativeSources = nativeSourcePaths.map((path) => relative(root, path)).sort();
  const missingFromInventory = [...relativeSources, ...nativeSources]
    .filter((path) => !required.has(path)).sort();

  return Object.freeze({
    entrypoints: PRODUCTION_ENTRYPOINTS,
    reachable: Object.freeze([...reachable].map((path) => relative(root, path)).sort()),
    nativeSources: Object.freeze(nativeSources),
    intentionallyUnshipped: INTENTIONALLY_UNSHIPPED_MODULES,
    unresolvedImports: Object.freeze(unresolvedImports),
    unexpectedUnreachable: Object.freeze(unexpectedUnreachable),
    staleUnshipped: Object.freeze(staleUnshipped),
    missingFromInventory: Object.freeze(missingFromInventory),
  });
}

export function assertCurrentSourceReachability(root, requiredPaths) {
  const result = analyzeCurrentSourceReachability(root, requiredPaths);
  const failures = [
    ['Unresolved relative imports', result.unresolvedImports],
    ['Unexpected unreachable production modules', result.unexpectedUnreachable],
    ['Stale intentionally-unshipped classifications', result.staleUnshipped],
    ['JavaScript or Swift source missing from release inventory', result.missingFromInventory],
  ].filter(([, paths]) => paths.length);
  if (failures.length) {
    const error = new Error(failures.map(([label, paths]) => `${label}:\n${paths.join('\n')}`).join('\n'));
    error.code = 'SOURCE_REACHABILITY_FAILED';
    throw error;
  }
  return result;
}
