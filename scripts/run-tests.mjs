import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTestFiles } from './test-files.mjs';
import { prepareNativeTests } from './prepare-native-tests.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
prepareNativeTests(root);
const result = spawnSync(process.execPath, ['--test', ...discoverTestFiles(resolve(root, 'tests'))], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
