import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectReleaseArtifactPaths,
  collectRuntimeBrowserStylesheetPaths,
} from '../../tools/verify/release-artifact-manifest.mjs';
import { currentLocalReleasePolicy } from '../../tools/release/validate-current-release.mjs';
import { createLocalSbom } from '../../tools/release/local-sbom.mjs';

async function fixture({ pagesPath = 'demo', screenshotPath = 'docs/screenshots/nested/proof.png' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'platen-release-inventory-'));
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await mkdir(join(root, 'demo'), { recursive: true });
  await mkdir(join(root, 'docs/screenshots/nested'), { recursive: true });
  await mkdir(join(root, 'src/browser/styles'), { recursive: true });
  await writeFile(join(root, '.github/workflows/pages.yml'), `steps:\n  - uses: actions/upload-pages-artifact@v4\n    with:\n      path: ${pagesPath}\n`);
  await writeFile(join(root, 'index.html'), '<link rel="stylesheet" href="/src/browser/styles/app.css">');
  await writeFile(join(root, 'src/browser/styles/app.css'), '@import "./nested.css";');
  await writeFile(join(root, 'src/browser/styles/nested.css'), '@import url("./deeper.css") screen;');
  await writeFile(join(root, 'src/browser/styles/deeper.css'), '.fixture { color: black; }');
  await writeFile(join(root, 'demo/index.html'), '<!doctype html>');
  await writeFile(join(root, 'docs/screenshots/nested/proof.png'), 'fixture');
  await writeFile(join(root, 'docs/screenshots/manifest.json'), JSON.stringify({
    screenshots: [{ path: screenshotPath }],
  }));
  return root;
}

test('release inventory includes recursively declared screenshot assets and all Pages deployment files', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const paths = collectReleaseArtifactPaths(root);
  assert.ok(paths.includes('docs/screenshots/nested/proof.png'));
  assert.ok(paths.includes('demo/index.html'));
  assert.ok(paths.includes('src/browser/styles/app.css'));
  assert.ok(paths.includes('src/browser/styles/nested.css'));
  assert.ok(paths.includes('src/browser/styles/deeper.css'));
});

test('release inventory receipts every stylesheet reached by HTML and recursive CSS imports', () => {
  const stylesheets = collectRuntimeBrowserStylesheetPaths(process.cwd());
  const receipt = currentLocalReleasePolicy(process.cwd()).requiredPaths;

  assert.ok(stylesheets.length > 1, 'Expected the browser shell to reach more than its CSS entrypoint.');
  for (const path of stylesheets) {
    assert.ok(receipt.includes(path), `expected runtime stylesheet ${path} in the local release receipt`);
  }
});

test('release inventory rejects stale screenshot manifests and Pages deployment roots', async (t) => {
  const staleScreenshotRoot = await fixture({ screenshotPath: 'docs/screenshots/nested/missing.png' });
  const stalePagesRoot = await fixture({ pagesPath: 'site' });
  t.after(async () => {
    await Promise.all([
      rm(staleScreenshotRoot, { recursive: true, force: true }),
      rm(stalePagesRoot, { recursive: true, force: true }),
    ]);
  });

  assert.throws(() => collectReleaseArtifactPaths(staleScreenshotRoot), /document asset manifest is stale/);
  assert.throws(() => collectReleaseArtifactPaths(stalePagesRoot), /deployment roots must match/);
});

test('current release policy receipts the Pages workflow, deployment payload, and screenshot evidence', () => {
  const paths = currentLocalReleasePolicy(process.cwd()).requiredPaths;
  for (const path of [
    '.github/workflows/pages.yml',
    'demo/index.html',
    'docs/screenshots/manifest.json',
    'docs/screenshots/editor-ready.png',
  ]) assert.ok(paths.includes(path), `expected ${path} in the local release policy`);
});

test('local SBOM accepts the explicitly inventoried Pages workflow path', () => {
  const sbom = createLocalSbom({
    files: [{ path: '.github/workflows/pages.yml', sha256: 'a'.repeat(64), size: 1 }],
    packageMetadata: {
      name: 'platen', version: '0.3.0-alpha.1', license: 'MIT', private: true, nodeEngine: '>=20',
    },
    dependencyGroups: {
      dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [],
    },
  });
  assert.equal(sbom.files[0].path, '.github/workflows/pages.yml');
});
