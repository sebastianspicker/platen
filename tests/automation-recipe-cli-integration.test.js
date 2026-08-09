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

test('real recipe CLI preserves one digest-bound pending job across application restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-recipe-cli-integration-'));
  const automationRoot = join(root, 'automation');
  const input = join(root, 'input.pdf');
  await mkdir(automationRoot, { mode: 0o700 });
  await writeFile(input, createBlankPdf({ pages: 1 }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const run = async () => {
    const output = capture();
    await runCli([
      'automation-run-recipe', input,
      '--recipe', 'inspect-document-v1',
      '--automation-root', automationRoot,
    ], { stdout: output.stream });
    return output.value();
  };

  const first = await run();
  const second = await run();
  assert.equal(first.kind, 'automation-declarative-recipe-run');
  assert.equal(first.releaseReceipt.released, true);
  assert.equal(first.executionReceipt.javascriptExecuted, false);
  assert.deepEqual(second.executionReceipt.jobs.map(({ id }) => id),
    first.executionReceipt.jobs.map(({ id }) => id));
  assert.deepEqual(second.executionReceipt.jobs.map(({ idempotent }) => idempotent), [true]);

  const journal = JSON.parse(await readFile(join(automationRoot, 'queue', 'journal.json'), 'utf8'));
  assert.equal(journal.jobs.length, 1);
  assert.equal(journal.jobs[0].status, 'pending');
  assert.equal(journal.jobs[0].payload.sourceId, first.source.id);
  assert.equal(journal.jobs[0].payload.sha256, first.source.sha256);
  const transaction = JSON.parse(await readFile(
    join(automationRoot, 'sources', first.source.id, 'transaction.json'), 'utf8',
  ));
  assert.equal(transaction.state, 'committed');
  assert.equal(transaction.ref.sha256, first.source.sha256);
});
