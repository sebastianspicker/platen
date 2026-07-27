import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function runSwiftBuild(swift, root, args) {
  const result = spawnSync(swift, ['build', '--disable-sandbox', ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function prepareNativeTests(root) {
  if (process.platform !== 'darwin') return;

  const lookup = spawnSync('/usr/bin/xcrun', ['--find', 'swift'], { encoding: 'utf8' });
  if (lookup.status !== 0) return;
  const swift = lookup.stdout.trim();

  const pdfkitPackage = join(root, 'native/pdfkit-helper');
  runSwiftBuild(swift, root, ['--package-path', pdfkitPackage]);
  runSwiftBuild(swift, root, ['-c', 'release', '--package-path', pdfkitPackage]);
  runSwiftBuild(swift, root, ['--package-path', join(root, 'native/plugin-worker')]);
}
