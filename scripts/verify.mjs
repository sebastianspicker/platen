import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverTestFiles } from './test-files.mjs';
import { REQUIRED_FILES } from './verify-required-files.mjs';
import { assertCurrentSourceReachability } from './source-module-reachability.mjs';
import { prepareNativeTests } from './prepare-native-tests.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const required = REQUIRED_FILES;

for (const path of required) {
  if (!existsSync(join(root, path))) throw new Error(`Required scaffold file is missing: ${path}`);
}

for (const directory of ['catalog', 'contracts']) {
  for (const name of readdirSync(join(root, directory)).filter((entry) => entry.endsWith('.json'))) {
    JSON.parse(readFileSync(join(root, directory, name), 'utf8'));
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) {
  throw new Error('The dependency-free scaffold must not declare npm dependencies.');
}

const reachability = assertCurrentSourceReachability(root, required);

prepareNativeTests(root);
const testFiles = discoverTestFiles(join(root, 'tests'));
const result = spawnSync(process.execPath, ['--test', ...testFiles], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`Verified ${testFiles.length} test files, ${reachability.reachable.length} reachable production modules, exhaustive JavaScript and native Swift source inventory, strict JSON catalogs, and zero npm dependencies.`);
