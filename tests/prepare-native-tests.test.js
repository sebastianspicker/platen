import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareNativeTests } from '../scripts/prepare-native-tests.mjs';

function fixture(context) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'platen-native-prepare-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const relativePath of ['native/pdfkit-helper', 'native/plugin-worker']) {
    mkdirSync(join(root, relativePath, '.build'), { recursive: true });
  }
  return root;
}

function writeBuildPlan(packageRoot, recordedPackageRoot) {
  writeFileSync(
    join(packageRoot, '.build/debug.yaml'),
    `nodes:\n  "${recordedPackageRoot}/.build/arm64-apple-macosx/debug/product": {}\n`,
  );
}

function recordingSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/xcrun') return { status: 0, stdout: '/toolchain/swift\n' };
    return { status: 0 };
  };
}

test('native preparation cleans relocated SwiftPM state before rebuilding each affected package', (context) => {
  const root = fixture(context);
  const pdfkitPackage = join(root, 'native/pdfkit-helper');
  const pluginPackage = join(root, 'native/plugin-worker');
  writeBuildPlan(pdfkitPackage, '/previous/checkout/native/pdfkit-helper');
  writeBuildPlan(pluginPackage, '/previous/checkout/native/plugin-worker');
  const calls = [];

  prepareNativeTests(root, { platform: 'darwin', spawn: recordingSpawn(calls) });

  assert.deepEqual(calls.slice(1).map(({ args }) => args), [
    ['package', '--package-path', pdfkitPackage, 'clean'],
    ['build', '--disable-sandbox', '--package-path', pdfkitPackage],
    ['build', '--disable-sandbox', '-c', 'release', '--package-path', pdfkitPackage],
    ['package', '--package-path', pluginPackage, 'clean'],
    ['build', '--disable-sandbox', '--package-path', pluginPackage],
  ]);
});

test('native preparation preserves incremental SwiftPM state for the current checkout', (context) => {
  const root = fixture(context);
  const pdfkitPackage = join(root, 'native/pdfkit-helper');
  const pluginPackage = join(root, 'native/plugin-worker');
  writeBuildPlan(pdfkitPackage, pdfkitPackage);
  writeBuildPlan(pluginPackage, pluginPackage);
  const calls = [];

  prepareNativeTests(root, { platform: 'darwin', spawn: recordingSpawn(calls) });

  assert.equal(calls.some(({ args }) => args.includes('clean')), false);
  assert.equal(calls.filter(({ args }) => args[0] === 'build').length, 3);
});
