import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DocumentStore } from '../../src/host/platform/storage/document-store.mjs';

async function* sourceStream(bytes) {
  yield bytes;
}

test('DocumentStore retains immutable source copies, isolates job cleanup, and disposes its private root', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'platen-store-test-'));
  const storeRoot = join(temporaryRoot, 'store');
  t.after(async () => { await rm(temporaryRoot, { recursive: true, force: true }); });
  const store = await new DocumentStore({ root: storeRoot }).initialize();

  const callerBytes = Buffer.from('%PDF-1.7\nfirst source\n');
  const first = await store.createDocument({ stream: sourceStream(callerBytes), displayName: 'source.pdf' });
  callerBytes.fill(0);
  const firstPath = store.getSourcePath(first.id);
  assert.deepEqual(await readFile(firstPath), Buffer.from('%PDF-1.7\nfirst source\n'));
  assert.equal(await store.verifySource(first.id), true);
  assert.equal(Object.hasOwn(first, 'sourcePath'), false);

  const second = await store.createDocument({
    stream: sourceStream(Buffer.from('%PDF-1.7\nsecond source\n')),
    displayName: 'source.pdf',
  });
  assert.notEqual(second.id, first.id);
  assert.notEqual(store.getSourcePath(second.id), firstPath, 'same display names must not clobber retained sources');
  assert.deepEqual(await readFile(firstPath), Buffer.from('%PDF-1.7\nfirst source\n'));

  const workspace = await store.createJobWorkspace(first.id);
  await writeFile(join(workspace, 'transient.txt'), 'private job data');
  await store.cleanupJob(workspace);
  assert.equal(existsSync(workspace), false);
  await assert.rejects(store.cleanupJob(temporaryRoot), { code: 'INVALID_JOB_PATH' });

  const unsafeEngineOutput = join(temporaryRoot, 'engine-output.pdf');
  await writeFile(unsafeEngineOutput, 'not a PDF');
  await assert.rejects(
    store.promotePdfArtifact(first.id, unsafeEngineOutput, {
      displayName: 'derived.pdf',
      expectedSha256: 'b'.repeat(64),
      operation: {
        schemaVersion: 1,
        id: '22222222-2222-4222-8222-222222222222',
        type: 'test-artifact',
        inputs: [{ documentId: first.id, sha256: first.sha256, role: 'primary' }],
        parameters: {}, expected: {}, validation: { passed: true, validators: ['fixture'] },
        completedAt: '2026-08-30T00:00:00.000Z',
      },
    }),
    { code: 'INVALID_ENGINE_OUTPUT' },
  );
  assert.deepEqual(await readdir(join(storeRoot, 'artifacts')), [], 'rejected engine output must not leave a retained artifact');

  await store.dispose();
  assert.equal(existsSync(storeRoot), false);
});
