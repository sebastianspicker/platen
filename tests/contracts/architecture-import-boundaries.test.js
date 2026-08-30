import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceRoot = join(repositoryRoot, 'src');
const ARCHITECTURE_AREAS = new Set(['browser', 'contracts', 'host', 'cli']);
const HOST_LAYER_DEPENDENCIES = Object.freeze({
  root: new Set(['root', 'bootstrap']),
  bootstrap: new Set(['bootstrap', 'transport', 'application', 'platform']),
  transport: new Set(['transport', 'application', 'platform']),
  application: new Set(['application', 'platform']),
  platform: new Set(['platform']),
});
const SOURCE_EXTENSIONS = Object.freeze(['.js', '.mjs']);
const CONCRETE_RUNTIME_TYPES = /\bnew\s+(?:DocumentStore|InputAssetStore|WorkspaceStateStore|PluginPackageStore|EngineRegistry|ProcessRunner|PopplerAdapter|GhostscriptAdapter|LibreOfficeAdapter|ImageMagickAdapter|RasterAdapter|CupsfilterAdapter|PdfKitAdapter|OcrAdapter|OcrImageAdapter|SignatureTrustAdapter|SigningIdentityAdapter)\b/u;
const CONTRACT_RUNTIME_GLOBALS = /\b(?:Buffer|window|navigator|HTMLElement|EventTarget|CustomEvent|localStorage|sessionStorage|XMLHttpRequest|DOMParser)\b/u;
const CONTRACT_ENDPOINT_TRANSPORT = /\b(?:fetch|AbortSignal|structuredClone|encodeURIComponent|JSON\.(?:parse|stringify)|URL|URLSearchParams|TextEncoder|TextDecoder|atob|btoa)\b|\/(?:api|v\d+)\/|\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/u;
const CONTRACT_ENDPOINT_FACTORY = /\bcreate[A-Za-z0-9]*Endpoints\b/u;
const CONCRETE_CLI_STORE_ACCESS = /\bapplication\s*(?:(?:\?\.|\.)\s*(?:store|inputs)\b|(?:\?\.)?\s*\[\s*['"](?:store|inputs)['"]\s*\])/u;

function isLocalHostEndpointContract(path) {
  return /^contracts\/local-host-.*-contract\.js$/u.test(path);
}

function reachesConcreteCliStore(source) {
  return CONCRETE_CLI_STORE_ACCESS.test(source);
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && SOURCE_EXTENSIONS.includes(extname(entry.name)) ? [path] : [];
  });
}

function relativeImports(source) {
  const imports = [];
  const pattern = /(?:import\s*\(\s*|import\s+(?:[\s\S]*?\s+from\s+)?|export\s+(?:[\s\S]*?\s+from\s+)?)['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1].startsWith('.')) imports.push(match[1]);
  }
  return imports;
}

function resolveImport(from, specifier) {
  const candidate = resolve(dirname(from), specifier);
  const candidates = [candidate, ...SOURCE_EXTENSIONS.map((extension) => `${candidate}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => join(candidate, `index${extension}`))];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

function areaFor(path) {
  const [area] = relative(sourceRoot, path).split('/');
  return ARCHITECTURE_AREAS.has(area) ? area : null;
}

function hostLayerFor(path) {
  const hostRelativePath = relative(join(sourceRoot, 'host'), path);
  if (hostRelativePath.startsWith('bootstrap/')) return 'bootstrap';
  if (hostRelativePath.startsWith('transport/')) return 'transport';
  if (hostRelativePath.startsWith('application/')) return 'application';
  if (hostRelativePath.startsWith('platform/')) return 'platform';
  return hostRelativePath.startsWith('..') ? null : 'root';
}

function graphCycle(graph) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (node, trail) => {
    if (visiting.has(node)) return [...trail, node];
    if (visited.has(node)) return null;
    visiting.add(node);
    for (const neighbor of graph.get(node) ?? []) {
      const cycle = visit(neighbor, [...trail, node]);
      if (cycle) return cycle;
    }
    visiting.delete(node);
    visited.add(node);
    return null;
  };
  for (const node of graph.keys()) {
    const cycle = visit(node, []);
    if (cycle) return cycle;
  }
  return null;
}

test('src relative ESM imports resolve and architectural areas remain acyclic', () => {
  const graph = new Map([...ARCHITECTURE_AREAS].map((area) => [area, new Set()]));
  const unresolved = [];
  for (const file of sourceFiles(sourceRoot)) {
    const fromArea = areaFor(file);
    for (const specifier of relativeImports(readFileSync(file, 'utf8'))) {
      const target = resolveImport(file, specifier);
      if (!target) {
        unresolved.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
        continue;
      }
      const targetArea = areaFor(target);
      if (fromArea && targetArea && fromArea !== targetArea) graph.get(fromArea).add(targetArea);
    }
  }
  assert.deepEqual(unresolved, [], `Unresolved relative imports:\n${unresolved.join('\n')}`);
  const cycle = graphCycle(graph);
  assert.equal(cycle, null, `Architectural area cycle: ${cycle?.join(' -> ')}`);
});

test('browser shell and package entry points resolve to owned source paths', () => {
  const shell = readFileSync(join(repositoryRoot, 'index.html'), 'utf8');
  const assetPaths = [...shell.matchAll(/(?:href|src)="\/(src\/[^"?#]+)"/gu)]
    .map((match) => match[1]);
  assert.ok(assetPaths.length >= 2, 'The browser shell must declare its source assets.');
  for (const path of assetPaths) {
    assert.ok(existsSync(join(repositoryRoot, path)), `Missing browser shell asset: ${path}`);
  }

  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  for (const scriptName of ['cli', 'dev', 'report', 'test', 'verify']) {
    const command = manifest.scripts?.[scriptName];
    const entrypoint = typeof command === 'string' ? command.match(/^node\s+(\S+)/u)?.[1] : null;
    assert.ok(entrypoint, `${scriptName} must use a direct Node entry point.`);
    assert.ok(existsSync(join(repositoryRoot, entrypoint)), `Missing ${scriptName} entry point: ${entrypoint}`);
  }
});

test('src dependency directions preserve host, browser, contracts, and bootstrap boundaries', () => {
  const violations = [];
  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, 'utf8');
    const path = relative(sourceRoot, file);
    const area = areaFor(file);
    for (const specifier of relativeImports(source)) {
      const target = resolveImport(file, specifier);
      const targetArea = target ? areaFor(target) : null;
      if (/^host\/application\//u.test(path) && ['browser', 'cli'].includes(targetArea)) {
        violations.push(`${path} imports ${relative(sourceRoot, target)}`);
      }
      if (area === 'browser' && targetArea === 'host') violations.push(`${path} imports host implementation ${relative(sourceRoot, target)}`);
      if (area === 'cli' && targetArea === 'host' && ['bootstrap', 'transport', 'platform'].includes(hostLayerFor(target))) {
        violations.push(`${path} bypasses the host root by importing ${relative(sourceRoot, target)}`);
      }
      if (area === 'contracts' && ['browser', 'host', 'cli'].includes(targetArea)) violations.push(`${path} imports ${targetArea} ${relative(sourceRoot, target)}`);
      if (area === 'host' && targetArea === 'host') {
        const fromLayer = hostLayerFor(file);
        const targetLayer = hostLayerFor(target);
        if (!HOST_LAYER_DEPENDENCIES[fromLayer].has(targetLayer)) {
          violations.push(`${path} crosses upward from ${fromLayer} to ${targetLayer}: ${relative(sourceRoot, target)}`);
        }
      }
    }
    if (area === 'contracts' && (/from\s+['"]node:/u.test(source) || /import\s*\(\s*['"]node:/u.test(source) || CONTRACT_RUNTIME_GLOBALS.test(source))) {
      violations.push(`${path} uses a Node, Buffer, or DOM/browser runtime global`);
    }
    if (isLocalHostEndpointContract(path) && CONTRACT_ENDPOINT_TRANSPORT.test(source)) {
      violations.push(`${path} constructs HTTP transport, serializes payloads, or uses browser/runtime transport globals`);
    }
    if (isLocalHostEndpointContract(path) && CONTRACT_ENDPOINT_FACTORY.test(source)) {
      violations.push(`${path} constructs browser endpoint factories instead of defining neutral contracts`);
    }
    if (CONCRETE_RUNTIME_TYPES.test(source) && !path.startsWith('host/bootstrap/')) {
      violations.push(`${path} constructs a concrete runtime adapter or store outside host/bootstrap`);
    }
    if (area === 'cli' && reachesConcreteCliStore(source)) {
      violations.push(`${path} reaches through the CLI facade to a concrete store`);
    }
    if (/^browser\/core\/local-host-.*-endpoints\.js$/u.test(path)) {
      violations.push(`${path} places an HTTP endpoint factory outside browser/api`);
    }
  }
  assert.deepEqual(violations, [], `Architecture boundary violations:\n${violations.join('\n')}`);
});

test('CLI concrete-store guard covers direct, optional-chain, and bracket access', () => {
  for (const source of [
    'application.store.verifySource(id)',
    'application?.store?.verifySource(id)',
    "application['inputs'].get(id)",
    'application?.["store"]?.verifySource(id)',
  ]) assert.equal(reachesConcreteCliStore(source), true, source);
  assert.equal(reachesConcreteCliStore('application.cli.documents.verify(id)'), false);
});
