import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

// Source files are discovered from the declared production roots. Keep this manifest
// for the small set of non-source files that define a releasable local artifact.
export const RELEASE_ARTIFACTS = Object.freeze([
  Object.freeze({ path: 'package.json', intent: 'node-package-metadata' }),
  Object.freeze({ path: 'index.html', intent: 'browser-shell-entrypoint' }),
  Object.freeze({ path: 'README.md', intent: 'project-overview' }),
  Object.freeze({ path: 'SECURITY.md', intent: 'security-policy' }),
  Object.freeze({ path: 'CONTRIBUTING.md', intent: 'contributor-guidance' }),
  Object.freeze({ path: 'LICENSE', intent: 'license' }),
  Object.freeze({ path: 'CHANGELOG.md', intent: 'change-history' }),
  Object.freeze({ path: '.github/workflows/pages.yml', intent: 'github-pages-deployment-workflow' }),
  Object.freeze({ path: 'native/pdfkit-helper/Package.swift', intent: 'native-package-entrypoint' }),
]);

// Checked-in declarative records are release data, not production source modules.
export const RELEASE_ARTIFACT_ROOTS = Object.freeze([
  Object.freeze({ path: 'catalog', extensions: Object.freeze(['.json']), intent: 'catalog-record' }),
  Object.freeze({ path: 'schemas', extensions: Object.freeze(['.json']), intent: 'schema-record' }),
  Object.freeze({ path: 'docs', extensions: Object.freeze(['.md', '.json']), intent: 'release-documentation' }),
]);

// Keep these declarations at root granularity. Individual screenshot and Pages files
// are discovered from their checked-in declarations rather than enumerated here.
export const RELEASE_DOCUMENT_ASSET_MANIFESTS = Object.freeze([
  Object.freeze({
    path: 'docs/screenshots/manifest.json',
    assetRoot: 'docs/screenshots',
    extensions: Object.freeze(['.png']),
    intent: 'frontend-screenshot-evidence',
  }),
]);

export const RELEASE_PUBLICATION_ROOTS = Object.freeze([
  Object.freeze({ path: 'demo', intent: 'github-pages-deployment' }),
]);

// The browser shell is a release entrypoint in its own right. Runtime style
// dependencies are discovered from its stylesheet links and recursive CSS
// imports so a visual change cannot escape the local inventory receipt.
export const RUNTIME_BROWSER_HTML_ENTRYPOINTS = Object.freeze([
  'index.html',
]);

const STYLESHEET_LINK_PATTERN = /<link\b(?=[^>]*\brel\s*=\s*(?:"stylesheet"|'stylesheet'|stylesheet)(?:\s|>|\/))[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/giu;
const CSS_IMPORT_PATTERN = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s'"()]+))\s*\)?(?:\s+[^;]*)?;/giu;

function validRelativePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.includes('\\')
    && !path.startsWith('/')
    && !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function runtimeAssetFailure(message) {
  throw new Error(`Runtime browser stylesheet dependency is invalid: ${message}`);
}

function runtimeStylesheetReference(root, importer, reference) {
  if (typeof reference !== 'string' || !reference || reference.includes('\\')
    || reference.includes('?') || reference.includes('#') || reference.startsWith('//')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference)) {
    runtimeAssetFailure(`${relative(root, importer)} has an unsupported stylesheet reference.`);
  }
  const candidate = reference.startsWith('/')
    ? resolve(root, `.${reference}`)
    : resolve(dirname(importer), reference);
  const path = relative(root, candidate);
  if (!validRelativePath(path) || extname(path) !== '.css') {
    runtimeAssetFailure(`${relative(root, importer)} must reference a local CSS file.`);
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    runtimeAssetFailure(`${path} is missing.`);
  }
  return path;
}

function stylesheetReferences(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]);
}

/** Collects every local CSS asset reached by the checked-in browser HTML shell. */
export function collectRuntimeBrowserStylesheetPaths(root) {
  const pending = [];
  for (const htmlPath of RUNTIME_BROWSER_HTML_ENTRYPOINTS) {
    const htmlFile = join(root, htmlPath);
    if (!existsSync(htmlFile) || !statSync(htmlFile).isFile()) {
      runtimeAssetFailure(`${htmlPath} is missing.`);
    }
    const html = readFileSync(htmlFile, 'utf8');
    pending.push(...stylesheetReferences(html, STYLESHEET_LINK_PATTERN)
      .map((reference) => runtimeStylesheetReference(root, htmlFile, reference)));
  }

  const stylesheets = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (stylesheets.has(path)) continue;
    stylesheets.add(path);
    const stylesheet = join(root, path);
    const source = readFileSync(stylesheet, 'utf8');
    pending.push(...stylesheetReferences(source, CSS_IMPORT_PATTERN)
      .map((reference) => runtimeStylesheetReference(root, stylesheet, reference)));
  }
  return Object.freeze([...stylesheets].sort());
}

function assertReleaseArtifactManifest() {
  const paths = RELEASE_ARTIFACTS.map(({ path }) => path);
  if (new Set(paths).size !== paths.length || RELEASE_ARTIFACTS.some(({ path, intent }) => (
    typeof path !== 'string' || !path || typeof intent !== 'string' || !intent
  ))) {
    throw new Error('Release artifact manifest entries must have unique paths and explicit intent.');
  }
  if (RELEASE_ARTIFACTS.some(({ path }) => path.startsWith('src/') || path.startsWith('native/pdfkit-helper/Sources/'))) {
    throw new Error('Production source must be discovered from declared source roots, not listed as a release artifact.');
  }
  for (const declaration of [...RELEASE_ARTIFACT_ROOTS, ...RELEASE_DOCUMENT_ASSET_MANIFESTS, ...RELEASE_PUBLICATION_ROOTS]) {
    if (!validRelativePath(declaration.path) || typeof declaration.intent !== 'string' || !declaration.intent) {
      throw new Error('Release artifact roots must use safe relative paths and explicit intent.');
    }
  }
  for (const { path, assetRoot, extensions } of RELEASE_DOCUMENT_ASSET_MANIFESTS) {
    if (!validRelativePath(assetRoot) || !assetRoot.startsWith('docs/')
      || !Array.isArray(extensions) || !extensions.length || extensions.some((extension) => !/^\.[A-Za-z0-9]+$/.test(extension))) {
      throw new Error(`Release document asset declaration is invalid: ${path}`);
    }
  }
}

function filesBelow(root, directory, extensions = null) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(root, path, extensions);
    return entry.isFile() && (!extensions || extensions.has(extname(entry.name))) ? [relative(root, path)] : [];
  });
}

function documentAssetPaths(root, declaration) {
  const manifestPath = join(root, declaration.path);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Release document asset manifest is unreadable: ${declaration.path}`, { cause: error });
  }
  const declaredPaths = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'path') declaredPaths.push(child);
        visit(child);
      }
    }
  };
  visit(manifest);

  const allowedExtensions = new Set(declaration.extensions);
  if (!declaredPaths.length || declaredPaths.some((path) => (
    !validRelativePath(path)
    || !path.startsWith(`${declaration.assetRoot}/`)
    || !allowedExtensions.has(extname(path))
  )) || new Set(declaredPaths).size !== declaredPaths.length) {
    throw new Error(`Release document asset manifest has invalid declared assets: ${declaration.path}`);
  }

  const actualPaths = filesBelow(root, join(root, declaration.assetRoot), allowedExtensions).sort();
  const expectedPaths = [...declaredPaths].sort();
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((path, index) => path !== expectedPaths[index])) {
    throw new Error(`Release document asset manifest is stale: ${declaration.path}`);
  }
  return expectedPaths;
}

function pagesDeploymentRoots(root) {
  const workflowPath = join(root, '.github/workflows/pages.yml');
  let lines;
  try {
    lines = readFileSync(workflowPath, 'utf8').split(/\r?\n/);
  } catch (error) {
    throw new Error('GitHub Pages deployment workflow is unreadable.', { cause: error });
  }
  const roots = [];
  let isArtifactUpload = false;
  let inWith = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      isArtifactUpload = false;
      inWith = false;
    }
    const field = trimmed.replace(/^-\s+/, '');
    if (/^uses:\s*actions\/upload-pages-artifact@[^\s#]+(?:\s*(?:#.*)?)$/.test(field)) {
      isArtifactUpload = true;
      continue;
    }
    if (isArtifactUpload && field === 'with:') {
      inWith = true;
      continue;
    }
    if (isArtifactUpload && inWith && /^path:\s*/.test(field)) {
      const path = field.slice('path:'.length).trim().replace(/^['"]|['"]$/g, '').replace(/\/$/, '');
      if (!validRelativePath(path)) throw new Error('GitHub Pages deployment root must be a static safe relative path.');
      roots.push(path);
      isArtifactUpload = false;
      inWith = false;
    }
  }
  if (!roots.length || new Set(roots).size !== roots.length) {
    throw new Error('GitHub Pages deployment workflow must declare one or more unique static artifact roots.');
  }
  return roots.sort();
}

function assertPagesDeploymentRoots(root) {
  const declaredRoots = RELEASE_PUBLICATION_ROOTS.map(({ path }) => path).sort();
  const workflowRoots = pagesDeploymentRoots(root);
  if (declaredRoots.length !== workflowRoots.length
    || declaredRoots.some((path, index) => path !== workflowRoots[index])) {
    throw new Error('GitHub Pages deployment roots must match the release publication roots.');
  }
  for (const path of declaredRoots) {
    const directory = join(root, path);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      throw new Error(`Release publication root is missing: ${path}`);
    }
  }
}

export function collectReleaseArtifactPaths(root) {
  assertReleaseArtifactManifest();
  assertPagesDeploymentRoots(root);
  const declared = RELEASE_ARTIFACTS.map(({ path }) => path);
  const discovered = RELEASE_ARTIFACT_ROOTS.flatMap(({ path, extensions }) => filesBelow(
    root,
    join(root, path),
    new Set(extensions),
  ));
  const documentAssets = RELEASE_DOCUMENT_ASSET_MANIFESTS.flatMap((declaration) => documentAssetPaths(root, declaration));
  const publicationAssets = RELEASE_PUBLICATION_ROOTS.flatMap(({ path }) => filesBelow(root, join(root, path)));
  const runtimeStylesheets = collectRuntimeBrowserStylesheetPaths(root);
  return Object.freeze([...new Set([
    ...declared,
    ...discovered,
    ...documentAssets,
    ...publicationAssets,
    ...runtimeStylesheets,
  ])].sort());
}
