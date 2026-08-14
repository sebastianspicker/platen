import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalWatchDirectory, pruneWatchState, snapshotPdfDirectory, stablePdfCandidates } from '../scripts/host/watch-folder.mjs';

test('watch-folder snapshots are non-recursive, deterministic, and stability-gated', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-watch-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'nested'));
  await Promise.all([
    writeFile(join(directory, 'b.PDF'), '%PDF-b'),
    writeFile(join(directory, 'a.pdf'), '%PDF-a'),
    writeFile(join(directory, 'ignored.txt'), 'local'),
    writeFile(join(directory, 'nested', 'not-scanned.pdf'), '%PDF-nested'),
  ]);
  const canonical = await canonicalWatchDirectory(directory);
  const first = await snapshotPdfDirectory(canonical);
  const second = await snapshotPdfDirectory(canonical);
  assert.deepEqual(first.map(({ name }) => name), ['a.pdf', 'b.PDF']);
  assert.deepEqual(stablePdfCandidates(first, second).map(({ name }) => name), ['a.pdf', 'b.PDF']);
  const processed = new Map([['a.pdf', second[0].signature], ['missing.pdf', 'old']]);
  assert.deepEqual(stablePdfCandidates(first, second, processed).map(({ name }) => name), ['b.PDF']);
  pruneWatchState(processed, second);
  assert.equal(processed.has('missing.pdf'), false);
});

test('watch-folder snapshots reject PDF symlinks and bounded-directory overflow', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'platen-watch-path-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.txt');
  await writeFile(source, '%PDF-local');
  await symlink(source, join(directory, 'linked.pdf'));
  await assert.rejects(snapshotPdfDirectory(directory), { code: 'WATCH_INPUT_INVALID', status: 400 });
  await rm(join(directory, 'linked.pdf'));
  await Promise.all(Array.from({ length: 3 }, (_, index) => writeFile(join(directory, `${index}.pdf`), '%PDF-local')));
  await assert.rejects(snapshotPdfDirectory(directory, { maxEntries: 2, maxPdfFiles: 2 }), { code: 'WATCH_DIRECTORY_LIMIT', status: 413 });
});
