import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../scripts/platen-cli.mjs';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';
import { AUTOMATION_INSPECT_PRESET } from '../scripts/host/automation/automation-operation-contract.mjs';

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

test('real conditional CLI preserves its verified branch job across application restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-conditional-cli-integration-'));
  const automationRoot = join(root, 'automation');
  const input = join(root, 'input.pdf');
  const workflowPath = join(root, 'workflow.json');
  await mkdir(automationRoot, { mode: 0o700 });
  await writeFile(input, createBlankPdf({ pages: 1 }));
  await writeFile(workflowPath, JSON.stringify({
    workflowId: 'inspect-nonempty-v1',
    steps: [{
      stepId: 'inspect',
      condition: { field: 'document.pageCount', operator: 'gte', value: 1 },
      trueBranch: {
        operation: { kind: 'preset', id: AUTOMATION_INSPECT_PRESET, pages: null },
        repeat: 1,
      },
      falseBranch: { operation: null, repeat: 1 },
    }],
  }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const run = async () => {
    const output = capture();
    await runCli([
      'automation-run-conditional', input,
      '--workflow', workflowPath,
      '--automation-root', automationRoot,
    ], { stdout: output.stream });
    return output.value();
  };

  const first = await run();
  const second = await run();
  const firstJobs = first.executionReceipt.steps.flatMap(({ jobs }) => jobs);
  const secondJobs = second.executionReceipt.steps.flatMap(({ jobs }) => jobs);
  assert.equal(first.kind, 'automation-declarative-conditional-run');
  assert.equal(first.releaseReceipt.released, true);
  assert.equal(first.executionReceipt.workflowId, 'inspect-nonempty-v1');
  assert.equal(first.executionReceipt.steps[0].matched, true);
  assert.deepEqual(secondJobs.map(({ id }) => id), firstJobs.map(({ id }) => id));
  assert.deepEqual(secondJobs.map(({ idempotent }) => idempotent), [true]);

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
