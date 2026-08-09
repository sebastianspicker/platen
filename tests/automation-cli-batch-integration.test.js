import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../scripts/platen-cli.mjs';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';

function capture() {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += chunk.toString();
        callback();
      },
    }),
    value: () => JSON.parse(text),
  };
}

test('real batch CLI preserves two source-bound pending jobs across restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-batch-cli-integration-'));
  const automationRoot = join(root, 'automation');
  const firstInput = join(root, 'first.pdf');
  const secondInput = join(root, 'second.pdf');
  const batchIdentity = 'integration-batch-1';
  await mkdir(automationRoot, { mode: 0o700 });
  await writeFile(firstInput, createBlankPdf({ pages: 1 }));
  await writeFile(secondInput, createBlankPdf({ pages: 2 }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const run = async () => {
    const output = capture();
    await runCli([
      'automation-submit-batch', firstInput, secondInput,
      '--operation', 'inspect',
      '--idempotency-key', batchIdentity,
      '--automation-root', automationRoot,
    ], { stdout: output.stream });
    return output.value();
  };

  const first = await run();
  const second = await run();
  assert.equal(first.count, 2);
  assert.equal(first.localOnly, true);
  assert.deepEqual(first.items.map(({ idempotent }) => idempotent), [false, false]);
  assert.deepEqual(second.items.map(({ idempotent }) => idempotent), [true, true]);
  assert.deepEqual(second.items.map(({ job }) => job.id), first.items.map(({ job }) => job.id));
  assert.doesNotMatch(JSON.stringify(second), /integration-batch-1|first\.pdf|second\.pdf/u);

  const journal = JSON.parse(await readFile(join(automationRoot, 'queue', 'journal.json'), 'utf8'));
  assert.equal(journal.jobs.length, 2);
  assert.deepEqual(journal.jobs.map(({ status }) => status), ['pending', 'pending']);
  for (const item of first.items) {
    const transaction = JSON.parse(await readFile(
      join(automationRoot, 'sources', item.source.id, 'transaction.json'),
      'utf8',
    ));
    assert.equal(transaction.state, 'committed');
    assert.equal(transaction.ref.sha256, item.source.sha256);
  }
});
