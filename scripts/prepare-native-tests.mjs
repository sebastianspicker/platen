import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

function runSwift(swift, root, args, spawn) {
  const result = spawn(swift, args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function hasRelocatedBuildState(packageRoot) {
  const expectedBuildRoot = `${realpathSync(packageRoot)}/.build/`;

  return ['debug.yaml', 'release.yaml'].some((name) => {
    const planPath = join(packageRoot, '.build', name);
    if (!existsSync(planPath)) return false;
    const recordedBuildRoot = readFileSync(planPath, 'utf8').match(/"(\/[^"\n]*\/\.build\/)/)?.[1];
    return recordedBuildRoot !== undefined && recordedBuildRoot !== expectedBuildRoot;
  });
}

function prepareSwiftPackage(swift, root, packageRoot, configurations, spawn) {
  if (hasRelocatedBuildState(packageRoot)) {
    runSwift(swift, root, ['package', '--package-path', packageRoot, 'clean'], spawn);
  }

  for (const configuration of configurations) {
    runSwift(swift, root, ['build', '--disable-sandbox', ...configuration, '--package-path', packageRoot], spawn);
  }
}

export function prepareNativeTests(root, { platform = process.platform, spawn = spawnSync } = {}) {
  if (platform !== 'darwin') return;

  const lookup = spawn('/usr/bin/xcrun', ['--find', 'swift'], { encoding: 'utf8' });
  if (lookup.status !== 0) return;
  const swift = lookup.stdout.trim();

  const pdfkitPackage = join(root, 'native/pdfkit-helper');
  prepareSwiftPackage(swift, root, pdfkitPackage, [[], ['-c', 'release']], spawn);
  prepareSwiftPackage(swift, root, join(root, 'native/plugin-worker'), [[]], spawn);
}
