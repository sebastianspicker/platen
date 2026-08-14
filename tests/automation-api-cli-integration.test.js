import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../scripts/platen-cli.mjs';
import { createLocalApplication } from '../scripts/local-host.mjs';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';
import {
  AUTOMATION_INSPECT_PRESET,
  AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE,
  AUTOMATION_FULL_PAGE_REDACTION_TYPE,
} from '../scripts/host/automation/automation-operation-contract.mjs';
import { AUTOMATION_SEQUENCE_IDS, AUTOMATION_SEQUENCE_TYPE } from '../scripts/host/automation/automation-sequence-contract.mjs';
import { runSingleSubmissionCommand } from '../scripts/cli/commands/automation-submission.mjs';
import { runAutomationCliBatchCommand } from '../scripts/cli/commands/automation-cli-batch.mjs';
import { HostError } from '../scripts/host/host-error.mjs';

function capture() {
  let text = '';
  return { stream: new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } }),
    value: () => JSON.parse(text) };
}

test('single-submit CLI uses API admission with a durable source transaction across restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-api-cli-'));
  const automationRoot = join(root, 'automation'); const input = join(root, 'input.pdf');
  const drift = join(root, 'drift.pdf'); const key = 'api-submit-integration-1';
  await mkdir(automationRoot, { mode: 0o700 });
  await Promise.all([writeFile(input, createBlankPdf({ pages: 1 })), writeFile(drift, createBlankPdf({ pages: 2 }))]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = async (file = input) => {
    const output = capture();
    await runCli(['automation-submit-inspect', file, '--automation-root', automationRoot,
      '--idempotency-key', key], { stdout: output.stream });
    return output.value();
  };
  const first = await run(); const second = await run();
  assert.equal(first.idempotent, false); assert.equal(second.idempotent, true);
  assert.equal(second.job.id, first.job.id);
  const journal = JSON.parse(await readFile(join(automationRoot, 'queue', 'journal.json'), 'utf8'));
  assert.equal(journal.jobs.length, 1);
  assert.deepEqual(journal.jobs[0].transaction, { source: {
    kind: 'source', id: first.source.id, sha256: first.source.sha256, size: first.source.size,
    sourceId: first.source.id, sourceSha256: first.source.sha256,
  }, output: null });
  const marker = JSON.parse(await readFile(join(automationRoot, 'sources', first.source.id, 'transaction.json'), 'utf8'));
  assert.equal(marker.state, 'committed');
  await assert.rejects(run(drift), { code: 'AUTOMATION_API_ADMISSION_CONFLICT' });
  assert.equal((await readdir(join(automationRoot, 'sources'))).filter((entry) => entry !== 'transactions.json').length, 2);
  await run();
  assert.deepEqual(await readdir(join(automationRoot, 'sources')), [first.source.id]);
});

test('single-submit CLI routes every fixed API selection through exact durable admission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-api-matrix-'));
  const input = join(root, 'input.pdf');
  await writeFile(input, createBlankPdf({ pages: 1 }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    { name: 'inspect', args: ['automation-submit-inspect'], type: AUTOMATION_INSPECT_TYPE },
    { name: 'ocr', args: ['automation-submit-ocr'], type: AUTOMATION_OCR_TYPE },
    { name: 'intent', args: ['automation-submit-output-intent'], type: AUTOMATION_OUTPUT_INTENT_TYPE },
    { name: 'redaction', args: ['automation-submit-full-page-redaction', '--pages', '1'], type: AUTOMATION_FULL_PAGE_REDACTION_TYPE, pages: [1] },
    { name: 'preset', args: ['automation-submit', '--preset', AUTOMATION_INSPECT_PRESET], type: AUTOMATION_INSPECT_TYPE, preset: AUTOMATION_INSPECT_PRESET },
    { name: 'sequence', args: ['automation-submit-sequence', '--sequence', AUTOMATION_SEQUENCE_IDS[0]], type: AUTOMATION_SEQUENCE_TYPE, sequence: AUTOMATION_SEQUENCE_IDS[0] },
  ];
  for (const item of cases) {
    const automationRoot = join(root, item.name);
    await mkdir(automationRoot, { mode: 0o700 });
    const output = capture();
    await runCli([item.args[0], input, ...item.args.slice(1), '--automation-root', automationRoot,
      '--idempotency-key', `matrix-${item.name}`], { stdout: output.stream });
    const receipt = output.value();
    assert.equal(receipt.job.type, item.type);
    const journal = JSON.parse(await readFile(join(automationRoot, 'queue', 'journal.json'), 'utf8'));
    const queued = journal.jobs[0];
    assert.equal(queued.type, item.type);
    assert.equal(queued.transaction.source.sha256, receipt.source.sha256);
    if (item.pages) assert.deepEqual(queued.payload.pages, item.pages);
    if (item.preset) assert.equal(queued.payload.preset, item.preset);
    if (item.sequence) assert.equal(queued.payload.sequenceId, item.sequence);
  }
});

test('source commit uncertainty recovers and replays on the next clean application open', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-api-commit-recovery-'));
  const automationRoot = join(root, 'automation'); const input = join(root, 'input.pdf');
  await mkdir(automationRoot, { mode: 0o700 });
  await writeFile(input, createBlankPdf({ pages: 1 }));
  t.after(() => rm(root, { recursive: true, force: true }));
  let failedCommit = false;
  await assert.rejects(runCli(['automation-submit-inspect', input, '--automation-root', automationRoot,
    '--idempotency-key', 'commit-uncertain'], {
    createApplication: async (options) => {
      const application = await createLocalApplication(options);
      const commit = application.automation.sources.commit.bind(application.automation.sources);
      application.automation.sources.commit = async (source) => {
        if (!failedCommit) { failedCommit = true; throw new Error('commit acknowledgement failed'); }
        return commit(source);
      };
      return application;
    },
  }), { code: 'AUTOMATION_API_SOURCE_COMMIT_UNCERTAIN' });
  const [sourceId] = (await readdir(join(automationRoot, 'sources'))).filter((name) => name !== 'transactions.json');
  assert.equal(JSON.parse(await readFile(join(automationRoot, 'sources', sourceId, 'transaction.json'), 'utf8')).state, 'staged');
  const output = capture();
  await runCli(['automation-submit-inspect', input, '--automation-root', automationRoot,
    '--idempotency-key', 'commit-uncertain'], { stdout: output.stream });
  assert.equal(output.value().idempotent, true);
  assert.equal(JSON.parse(await readFile(join(automationRoot, 'sources', sourceId, 'transaction.json'), 'utf8')).state, 'committed');
  assert.deepEqual(await readdir(join(automationRoot, 'sources')), [sourceId]);
});

test('single-submit cleans a staged source after a known pre-admission API failure', async () => {
  const events = [];
  const source = { id: 'source_1', sha256: 'a'.repeat(64), size: 10 };
  const application = { store: { async deleteDocument(id) { events.push(['delete', id]); } }, automation: {
    sources: {
      async stageDocument() { events.push(['stage']); return source; },
      async discardCreated(value) { events.push(['discard', value.id]); return true; },
    },
    api: { async submit() { throw new HostError('AUTOMATION_API_QUEUE_FULL', 'full', 429); } },
  } };
  const runtime = {
    async uploadPdf() { return { id: 'document_1', sha256: source.sha256, size: source.size }; },
    cancelled() {}, async outputValue() {},
  };
  await assert.rejects(runSingleSubmissionCommand(application, application.automation, {
    command: 'automation-submit-inspect', input: 'input.pdf', automationRoot: 'private',
    idempotencyKey: 'known-pre-admission', output: null,
  }, {}, runtime), { code: 'AUTOMATION_API_QUEUE_FULL' });
  assert.deepEqual(events, [['stage'], ['discard', 'source_1'], ['delete', 'document_1']]);
});

test('custom OCR remains on the direct submission path and batch never calls the API', async () => {
  const events = []; const jobs = new Map(); let sourceNumber = 0; let apiCalls = 0;
  const documents = new Map([
    ['ocr.pdf', { id: 'ocr', sha256: 'a'.repeat(64), size: 10 }],
    ['one.pdf', { id: 'one', sha256: 'b'.repeat(64), size: 10 }],
    ['two.pdf', { id: 'two', sha256: 'c'.repeat(64), size: 10 }],
  ]);
  const application = { store: { async deleteDocument() {} }, automation: {
    api: { async submit() { apiCalls += 1; throw new Error('API must not receive this command'); } },
    sources: {
      async stageDocument({ documentId }) { const document = [...documents.values()].find((item) => item.id === documentId); return { id: `source_${++sourceNumber}`, sha256: document.sha256, size: document.size }; },
      async commit() {}, async discardCreated() {},
      async openVerified() { return { id: 'source_1', sha256: 'a'.repeat(64), size: 10, stream: { destroy() {} } }; },
    },
    registry: {
      enqueueRequest(source) { return { type: 'automation_inspect_v1', payload: { sourceId: source.id, sha256: source.sha256 } }; },
      enqueueOcrRequest(source, options) { events.push(options); return { type: 'automation_ocr_v1', payload: { sourceId: source.id, sha256: source.sha256, ...options } }; },
    },
    queue: {
      async admission(key) { return { accepting: true, existing: jobs.get(key) ?? null }; },
      async enqueue(value) { const job = { id: `job_${jobs.size + 1}`, type: value.type, payload: value.payload, status: 'pending' }; jobs.set(value.idempotencyKey, job); return { job, idempotent: false }; },
    },
  } };
  const runtime = { async uploadPdf(_application, input) { return documents.get(input); }, cancelled() {},
    async outputValue(_command, _stdout, value) { events.push(value); } };
  await runSingleSubmissionCommand(application, application.automation, {
    command: 'automation-submit-ocr', input: 'ocr.pdf', automationRoot: 'private', idempotencyKey: 'ocr-custom', output: null,
    language: 'deu', cleanupPreset: 'none', segmentation: 'block',
  }, {}, runtime);
  assert.deepEqual(events[0], { language: 'deu', cleanupPreset: 'none', segmentation: 'block', userDictionary: [] });
  await runAutomationCliBatchCommand(application, {
    command: 'automation-submit-batch', inputs: ['one.pdf', 'two.pdf'], automationRoot: 'private',
    operation: 'inspect', idempotencyKey: 'batch-direct', output: null,
  }, {}, runtime);
  assert.equal(apiCalls, 0);
  assert.equal(events.at(-1).count, 2);
});
