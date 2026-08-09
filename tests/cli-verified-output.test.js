import assert from 'node:assert/strict';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import {
  access, link, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeExclusiveVerified } from '../scripts/cli/runtime.mjs';

test('verified output publishes one immutable private receipt and retains its inode', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-output-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'snapshot.png');
  const bytes = Buffer.from('bounded png bytes');
  const receipt = await writeExclusiveVerified(output, bytes);
  const before = await lstat(output);
  assert.deepEqual(receipt, { size: bytes.length, sha256: '38e68eadd5e1f841bb50a455dfd0eabe207f18b75b34ac05bc067727cb6b7424' });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(before.isFile(), true);
  assert.equal(before.nlink, 1);
  assert.equal(before.mode & 0o777, 0o600);
  assert.equal((await readFile(output)).equals(bytes), true);
  const after = await lstat(output);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.throws(() => { receipt.size = 0; }, TypeError);
  assert.equal(receipt.size, bytes.length);
});

test('verified output finalizer receives the frozen receipt before the transaction commits', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-finalize-success-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'finalized.png');
  const bytes = Buffer.from('finalized bytes');
  let seen = null;
  const receipt = await writeExclusiveVerified(output, bytes, undefined, async (value) => {
    seen = value;
    assert.equal(Object.isFrozen(value), true);
  });
  assert.strictEqual(seen, receipt);
  assert.equal((await readFile(output)).equals(bytes), true);
});

test('verified output finalizer failure removes the published inode and rethrows its stable error', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-finalize-failure-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'failed-finalize.png');
  const failure = Object.assign(new Error('finalizer failed'), { code: 'CLI_FINALIZE_FAILED' });
  await assert.rejects(
    writeExclusiveVerified(output, Buffer.from('finalize failure'), undefined, async () => { throw failure; }),
    (error) => error === failure,
  );
  await assert.rejects(access(output));
});

test('verified output commits when a successful finalizer aborts after receipt emission', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-finalize-cancel-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'cancelled-finalize.png');
  const controller = new AbortController();
  const bytes = Buffer.from('finalize cancellation');
  const receipt = await writeExclusiveVerified(
    output,
    bytes,
    controller.signal,
    async () => { controller.abort(); },
  );
  assert.equal(receipt.size, bytes.length);
  assert.equal((await readFile(output)).equals(bytes), true);
});

test('verified output rolls back when the finalizer explicitly throws cancellation', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-finalize-throw-cancel-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'thrown-cancelled-finalize.png');
  const controller = new AbortController();
  await assert.rejects(
    writeExclusiveVerified(output, Buffer.from('thrown finalizer cancellation'), controller.signal, async () => {
      controller.abort();
      throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' });
    }),
    { code: 'JOB_CANCELLED' },
  );
  await assert.rejects(access(output));
});

test('verified output rejects an invalid finalizer before publication', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-finalize-invalid-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'invalid-finalize.png');
  await assert.rejects(writeExclusiveVerified(output, Buffer.from('invalid finalizer'), undefined, {}), TypeError);
  await assert.rejects(access(output));
});

test('verified output refuses existing files, symlinks, and hard links', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-existing-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('new bytes');
  const source = join(directory, 'source');
  await writeFile(source, Buffer.from('unrelated'), { mode: 0o600 });
  for (const [name, createTarget] of [
    ['file', async (target) => writeFile(target, Buffer.from('existing'), { mode: 0o600 })],
    ['symlink', (target) => symlink(source, target)],
    ['hardlink', (target) => link(source, target)],
  ]) {
    const target = join(directory, name);
    await createTarget(target);
    await assert.rejects(writeExclusiveVerified(target, bytes), { code: 'CLI_OUTPUT_EXISTS' });
    assert.equal((await readFile(source)).toString(), 'unrelated');
  }
});

test('verified output cancellation before publication leaves no partial output', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-cancel-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'cancelled.png');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(writeExclusiveVerified(output, Buffer.from('cancelled'), controller.signal), { code: 'JOB_CANCELLED' });
  await assert.rejects(access(output));
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.partial')), []);
});

test('verified output removes its private partial on cancellation after staging starts', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-stage-cancel-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'staged-cancelled.png');
  let checks = 0;
  const signal = { get aborted() { checks += 1; return checks >= 2; } };
  await assert.rejects(writeExclusiveVerified(output, Buffer.from('cancelled'), signal), { code: 'JOB_CANCELLED' });
  await assert.rejects(access(output));
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.partial')), []);
});

test('verified output rejects same-inode content drift and removes only that inode', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-drift-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'drifted.png');
  let checks = 0;
  const signal = {
    get aborted() {
      checks += 1;
      if (checks === 9) writeFileSync(output, Buffer.from('xyz'), { mode: 0o600 });
      return false;
    },
  };
  await assert.rejects(writeExclusiveVerified(output, Buffer.from('abc'), signal), {
    code: 'CLI_OUTPUT_VERIFICATION_FAILED',
  });
  await assert.rejects(access(output));
});

test('verified output never removes an unrelated replacement after publication substitution', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-substitution-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'substituted.png');
  const original = Buffer.from('original');
  const replacement = Buffer.from('replacement');
  const moved = join(directory, 'moved-original');
  let substituted = false;
  const signal = {
    get aborted() {
      if (!substituted && existsSync(output)) {
        substituted = true;
        renameSync(output, moved);
        writeFileSync(output, replacement, { mode: 0o600 });
      }
      return substituted;
    },
  };
  await assert.rejects(writeExclusiveVerified(output, original, signal), { code: 'CLI_OUTPUT_CLEANUP_FAILED' });
  assert.equal((await readFile(output)).equals(replacement), true);
  assert.equal((await readFile(moved)).equals(original), true);
});

test('verified output finalizer never removes an unrelated replacement', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-cli-verified-finalize-substitution-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'finalize-substituted.png');
  const moved = join(directory, 'finalize-original');
  const original = Buffer.from('finalize original');
  const replacement = Buffer.from('finalize replacement');
  const failure = Object.assign(new Error('finalizer failed'), { code: 'CLI_FINALIZE_FAILED' });
  await assert.rejects(
    writeExclusiveVerified(output, original, undefined, async () => {
      renameSync(output, moved);
      writeFileSync(output, replacement, { mode: 0o600 });
      throw failure;
    }),
    { code: 'CLI_OUTPUT_CLEANUP_FAILED' },
  );
  assert.equal((await readFile(output)).equals(replacement), true);
  assert.equal((await readFile(moved)).equals(original), true);
});
