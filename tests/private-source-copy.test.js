import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, link, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertPrivateSourceCopy, stagePrivateSourceCopy } from '../scripts/host/private-source-copy.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('private source copy is descriptor-bound, digest-bound, private, and immutable across later source replacement', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'private-source-copy-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.pdf');
  const target = join(root, 'job-input.pdf');
  const original = Buffer.from('%PDF-1.7\noriginal immutable bytes\n%%EOF');
  await writeFile(source, original, { mode: 0o600 });
  const identity = await stagePrivateSourceCopy({
    sourcePath: source, targetPath: target, expectedSha256: digest(original),
    expectedSize: original.length, maximumBytes: 1024 * 1024,
  });
  assert.deepEqual(await readFile(target), original);
  assert.equal((await stat(target)).mode & 0o777, 0o400);

  const replacement = join(root, 'replacement.pdf');
  await writeFile(replacement, '%PDF-1.7\nreplacement\n%%EOF', { mode: 0o600 });
  await rename(replacement, source);
  await assert.doesNotReject(assertPrivateSourceCopy({
    path: target, identity, expectedSha256: digest(original),
    expectedSize: original.length, maximumBytes: 1024 * 1024,
  }));
});

test('private source copy rejects links, stale digests, and changed staged inputs', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'private-source-copy-hostile-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('%PDF-1.7\nsource\n%%EOF');
  const source = join(root, 'source.pdf');
  await writeFile(source, bytes, { mode: 0o600 });

  const symbolic = join(root, 'symbolic.pdf');
  await symlink(source, symbolic);
  await assert.rejects(stagePrivateSourceCopy({
    sourcePath: symbolic, targetPath: join(root, 'symbolic-copy.pdf'),
    expectedSha256: digest(bytes), expectedSize: bytes.length, maximumBytes: 1024,
  }));

  const hard = join(root, 'hard.pdf');
  await link(source, hard);
  await assert.rejects(stagePrivateSourceCopy({
    sourcePath: source, targetPath: join(root, 'hard-copy.pdf'),
    expectedSha256: digest(bytes), expectedSize: bytes.length, maximumBytes: 1024,
  }));
  await rm(hard);

  await assert.rejects(stagePrivateSourceCopy({
    sourcePath: source, targetPath: join(root, 'stale-copy.pdf'),
    expectedSha256: '0'.repeat(64), expectedSize: bytes.length, maximumBytes: 1024,
  }));

  const target = join(root, 'valid-copy.pdf');
  const identity = await stagePrivateSourceCopy({
    sourcePath: source, targetPath: target, expectedSha256: digest(bytes),
    expectedSize: bytes.length, maximumBytes: 1024,
  });
  await chmod(target, 0o600);
  await writeFile(target, Buffer.from('%PDF-1.7\nchanged\n%%EOF'));
  await assert.rejects(assertPrivateSourceCopy({
    path: target, identity, expectedSha256: digest(bytes),
    expectedSize: bytes.length, maximumBytes: 1024,
  }));
});

test('private source copy honors cancellation after staging begins without leaving a target', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'private-source-copy-cancelled-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('%PDF-1.7\ncancelled source\n%%EOF');
  const source = join(root, 'source.pdf');
  const target = join(root, 'cancelled-copy.pdf');
  await writeFile(source, bytes, { mode: 0o600 });
  const controller = new AbortController();
  const cancellation = new Error('cancelled copy');
  const signal = new Proxy(controller.signal, {
    get(targetSignal, property) {
      if (property === 'aborted' && existsSync(target)) controller.abort(cancellation);
      return Reflect.get(targetSignal, property, targetSignal);
    },
  });

  await assert.rejects(stagePrivateSourceCopy({
    sourcePath: source, targetPath: target, expectedSha256: digest(bytes),
    expectedSize: bytes.length, maximumBytes: 1024, signal,
  }), cancellation);
  await assert.rejects(stat(target), { code: 'ENOENT' });
});
