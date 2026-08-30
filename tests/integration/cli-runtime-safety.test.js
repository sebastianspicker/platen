import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runCli } from '../../src/cli/main.mjs';
import { runStructuredExportLocalCommand } from '../../src/cli/commands/structured-export.mjs';
import { writeExclusive } from '../../src/cli/runtime.mjs';

function collectingStream() {
  let value = '';
  return {
    write(chunk, callback) { value += chunk; callback?.(); return true; },
    get value() { return value; },
  };
}

test('CLI dispatches engines through the injected application and closes it after writing a local receipt', async () => {
  const stdout = collectingStream();
  let closed = 0;
  const application = {
    service: { availability: async () => [{ name: 'Poppler', available: true, version: 'fixture' }] },
    cli: { async close() { closed += 1; } },
  };
  await runCli(['engines'], { stdout, createApplication: async () => application });
  assert.deepEqual(JSON.parse(stdout.value), {
    localOnly: true,
    engines: [{ name: 'Poppler', available: true, version: 'fixture' }],
  });
  assert.equal(closed, 1);
});

test('CLI cancellation closes the composed application before any command service runs', async () => {
  const controller = new AbortController();
  controller.abort();
  let closed = 0;
  await assert.rejects(
    runCli(['engines'], {
      signal: controller.signal,
      createApplication: async () => ({
        service: { availability: async () => { throw new Error('cancelled command must not call service'); } },
        cli: { async close() { closed += 1; } },
      }),
    }),
    { code: 'JOB_CANCELLED' },
  );
  assert.equal(closed, 1);
});

test('CLI no-clobber publication preserves an existing output and cleans failed temporary state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-cli-output-test-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const target = join(root, 'report.json');
  await writeFile(target, 'original');
  await assert.rejects(writeExclusive(target, Buffer.from('replacement')), { code: 'CLI_OUTPUT_EXISTS' });
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.equal((await readdir(root)).some((name) => name.startsWith('.platen-') && name.endsWith('.partial')), false);
});

test('structured export verifies through the CLI facade without a concrete store', async () => {
  let facadeVerifications = 0;
  let emitted;
  const application = {
    cli: { documents: { async verify() { facadeVerifications += 1; return true; } } },
    service: {
      async inspect() { return { pageCount: 1 }; },
      async extractText() { return [{ page: 1, text: 'Facade-only export' }]; },
    },
  };
  const runtime = {
    async canonicalOutputTarget() {},
    cancelled() {},
    async emit(_stdout, value) { emitted = value; },
    fail(code, message) { const error = new Error(message); error.code = code; throw error; },
    async writeExclusiveVerified(_target, bytes, _signal, publish) {
      const { createHash } = await import('node:crypto');
      await publish({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    },
  };
  await runStructuredExportLocalCommand(
    application,
    { format: 'xml', output: 'facade.xml' },
    { id: 'document-1', sha256: 'a'.repeat(64), displayName: 'fixture.pdf' },
    collectingStream(),
    undefined,
    runtime,
  );
  assert.equal(facadeVerifications, 3);
  assert.equal(emitted.kind, 'structured-export-local');
});
