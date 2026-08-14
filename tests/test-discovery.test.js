import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverTestFiles } from '../scripts/test-files.mjs';

test('test discovery includes nested suites and excludes helpers', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-tests-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'integration'));
  await writeFile(join(directory, 'root.test.js'), '');
  await writeFile(join(directory, 'helper.js'), '');
  await writeFile(join(directory, 'integration', 'nested.test.js'), '');

  assert.deepEqual(discoverTestFiles(directory), [
    join(directory, 'integration', 'nested.test.js'),
    join(directory, 'root.test.js'),
  ]);
});
