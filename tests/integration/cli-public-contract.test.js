import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLI_HELP, runCli } from '../../src/cli/main.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

function collectingStream() {
  let value = '';
  return {
    write(chunk, callback) {
      value += chunk;
      callback?.();
      return true;
    },
    get value() { return value; },
  };
}

test('runCli writes help to the injected stdout stream without constructing the runtime', async () => {
  const stdout = collectingStream();
  let applicationCreated = false;
  await runCli(['help'], {
    stdout,
    createApplication: async () => { applicationCreated = true; throw new Error('help must not initialize the host application'); },
  });
  assert.equal(stdout.value, `${CLI_HELP}\n`);
  assert.equal(applicationCreated, false);
});

test('runCli preserves parser failures before host construction', async () => {
  const stdout = collectingStream();
  let applicationCreated = false;
  await assert.rejects(
    runCli(['inspect'], {
      stdout,
      createApplication: async () => { applicationCreated = true; throw new Error('invalid CLI input must not initialize the host application'); },
    }),
    { code: 'CLI_INVALID_ARGUMENTS', message: 'This command requires exactly 1 input path.' },
  );
  assert.equal(stdout.value, '');
  assert.equal(applicationCreated, false);
});

test('CLI entrypoint reports parser failures as stderr JSON and exits nonzero', () => {
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'src/cli/main.mjs'), 'inspect'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    error: {
      code: 'CLI_INVALID_ARGUMENTS',
      message: 'This command requires exactly 1 input path.',
      status: null,
    },
  });
});
