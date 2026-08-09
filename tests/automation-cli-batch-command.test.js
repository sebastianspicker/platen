import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runAutomationCliBatchCommand } from '../scripts/cli/commands/automation-cli-batch.mjs';
import {
  AUTOMATION_PRESET_IDS,
  automationPresetDescriptor,
} from '../scripts/host/automation/automation-operation-contract.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

function fixture({ limit = Infinity, onCommit = null } = {}) {
  const documents = new Map([
    ['one.pdf', { id: 'document-one', sha256: digest('one'), size: 3 }],
    ['two.pdf', { id: 'document-two', sha256: digest('two'), size: 3 }],
    ['three.pdf', { id: 'document-three', sha256: digest('three'), size: 5 }],
  ]);
  const jobs = new Map(); const sources = new Map(); const events = []; let sourceNumber = 0; let jobNumber = 0;
  const application = {
    store: { async deleteDocument(id) { events.push(['delete', id]); } },
    automation: {
      sources: {
        async stageDocument({ documentId }) {
          const document = [...documents.values()].find((item) => item.id === documentId);
          const source = { id: `source_${++sourceNumber}`, sha256: document.sha256, size: document.size };
          sources.set(source.id, source); events.push(['stage', source.id]); return source;
        },
        async openVerified(id, sha256) {
          const source = sources.get(id);
          if (!source || source.sha256 !== sha256) throw new Error('unexpected source open');
          return { ...source, stream: { destroy() {} } };
        },
        async commit(source) { events.push(['commit', source.id]); await onCommit?.(); },
        async discardCreated(source) { events.push(['discard', source.id]); },
      },
      registry: {
        enqueueRequest(source) { return { type: 'automation_inspect_v1', payload: { sourceId: source.id, sha256: source.sha256 } }; },
        enqueueOcrRequest(source, options) { return { type: 'automation_ocr_v1', payload: { sourceId: source.id, sha256: source.sha256, ...options } }; },
        enqueueOutputIntentRequest(source) { return { type: 'automation_output_intent_v1', payload: { sourceId: source.id, sha256: source.sha256, profile: 'local-ghostscript-default-cmyk-output-intent-v1' } }; },
        enqueueFullPageRedactionRequest(source, { pages }) { return { type: 'automation_full_page_redaction_v1', payload: { sourceId: source.id, sha256: source.sha256, pages } }; },
        enqueuePresetRequest(source, preset) {
          return {
            type: automationPresetDescriptor(preset).type,
            payload: { sourceId: source.id, sha256: source.sha256, preset },
          };
        },
      },
      queue: {
        async admission(key) { return { existing: jobs.get(key) ?? null, accepting: jobs.size < limit }; },
        async enqueue(request) {
          const job = { id: `job_${++jobNumber}`, type: request.type, payload: request.payload, idempotencyKey: request.idempotencyKey, status: 'queued' };
          jobs.set(request.idempotencyKey, job); events.push(['enqueue', request.idempotencyKey]); return { job, idempotent: false };
        },
      },
    },
  };
  const runtime = {
    async uploadPdf(_application, input) { events.push(['upload', input]); return documents.get(input); },
    cancelled(signal) { if (signal?.aborted) { const error = new Error('cancelled'); error.code = 'JOB_CANCELLED'; throw error; } },
    async outputValue(_command, _stdout, value) { events.push(['output', value]); },
  };
  const command = (overrides = {}) => ({ command: 'automation-submit-batch', inputs: ['one.pdf', 'two.pdf'], automationRoot: 'private', operation: 'inspect', idempotencyKey: 'caller-batch-identity', output: null, ...overrides });
  return { application, command, documents, events, jobs, runtime };
}

test('batch receipt is deterministic, bounded, and omits raw identity and paths', async () => {
  const state = fixture();
  await runAutomationCliBatchCommand(state.application, state.command(), {}, state.runtime);
  const first = state.events.at(-1)[1];
  await runAutomationCliBatchCommand(state.application, state.command(), {}, state.runtime);
  const second = state.events.at(-1)[1];
  assert.deepEqual(second.items.map(({ idempotent, ...item }) => item), first.items.map(({ idempotent, ...item }) => item));
  assert.equal(first.batchIdentityHash, digest('caller-batch-identity'));
  assert.equal(first.count, 2);
  assert.equal(first.localOnly, true);
  assert.equal(first.items.every((item) => item.idempotent === false), true);
  assert.equal(second.items.every((item) => item.idempotent === true), true);
  const serialized = JSON.stringify(second);
  assert.doesNotMatch(serialized, /caller-batch-identity|one\.pdf|two\.pdf|document-one|document-two/u);
  assert.equal([...state.jobs.values()].every((job) => /^automation-submit-batch-v1-[a-f0-9]{64}$/u.test(job.idempotencyKey)), true);
});

test('batch replay rejects operation parameters that drift at an existing ordinal', async () => {
  const cases = [
    [state => state.command(), state => state.command({ operation: 'output-intent' })],
    [state => state.command({ operation: 'ocr', language: 'eng' }),
      state => state.command({ operation: 'ocr', language: 'deu' })],
    [state => state.command({ operation: 'full-page-redaction', pages: [1] }),
      state => state.command({ operation: 'full-page-redaction', pages: [2] })],
    [state => state.command({ operation: undefined, preset: AUTOMATION_PRESET_IDS[0] }),
      state => state.command({ operation: undefined, preset: AUTOMATION_PRESET_IDS[1] })],
  ];
  for (const [firstCommand, driftedCommand] of cases) {
    const state = fixture();
    await runAutomationCliBatchCommand(state.application, firstCommand(state), {}, state.runtime);
    await assert.rejects(
      runAutomationCliBatchCommand(state.application, driftedCommand(state), {}, state.runtime),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  }
});

test('batch identity owns appendable ordinal lanes without cancelling trailing jobs', async () => {
  const state = fixture();
  await runAutomationCliBatchCommand(state.application, state.command(), {}, state.runtime);
  await runAutomationCliBatchCommand(state.application, state.command({
    inputs: ['one.pdf', 'two.pdf', 'three.pdf'],
  }), {}, state.runtime);
  assert.deepEqual(state.events.at(-1)[1].items.map(({ idempotent }) => idempotent), [true, true, false]);
  assert.equal(state.jobs.size, 3);
  await runAutomationCliBatchCommand(state.application, state.command(), {}, state.runtime);
  assert.deepEqual(state.events.at(-1)[1].items.map(({ idempotent }) => idempotent), [true, true]);
  assert.equal(state.jobs.size, 3);
});

test('receipt publication failure leaves admitted jobs replayable', async () => {
  const state = fixture();
  state.runtime.outputValue = async () => { throw new Error('receipt unavailable'); };
  await assert.rejects(
    runAutomationCliBatchCommand(state.application, state.command(), {}, state.runtime),
    /receipt unavailable/u,
  );
  assert.equal(state.jobs.size, 2);
  state.runtime.outputValue = async (_command, _stdout, value) => state.events.push(['output', value]);
  await runAutomationCliBatchCommand(state.application, state.command(), {}, state.runtime);
  assert.equal(state.events.at(-1)[1].items.every(({ idempotent }) => idempotent), true);
});

test('batch submits one immutable preset for every source and replays it', async () => {
  const state = fixture();
  const command = state.command({ operation: undefined, preset: AUTOMATION_PRESET_IDS[0] });
  await runAutomationCliBatchCommand(state.application, command, {}, state.runtime);
  await runAutomationCliBatchCommand(state.application, command, {}, state.runtime);
  const receipt = state.events.at(-1)[1];
  assert.equal(receipt.items.every(({ idempotent }) => idempotent), true);
  assert.equal([...state.jobs.values()].every(({ payload }) => (
    payload.preset === AUTOMATION_PRESET_IDS[0]
  )), true);
});

test('batch identity detects ordinal input drift and preserves committed jobs after partial failure', async () => {
  const state = fixture({ limit: 1 });
  await assert.rejects(runAutomationCliBatchCommand(state.application, state.command(), {}, state.runtime), { code: 'QUEUE_FULL' });
  assert.equal(state.jobs.size, 1);
  state.documents.set('one.pdf', { id: 'document-one-drift', sha256: digest('drift'), size: 5 });
  await assert.rejects(runAutomationCliBatchCommand(state.application, state.command(), {}, state.runtime), { code: 'IDEMPOTENCY_CONFLICT' });
  state.documents.set('one.pdf', { id: 'document-one', sha256: digest('one'), size: 3 });
  // Re-open the same queue with capacity for the remaining ordinal.
  state.application.automation.queue.admission = async (key) => ({ existing: state.jobs.get(key) ?? null, accepting: true });
  await runAutomationCliBatchCommand(state.application, state.command(), {}, state.runtime);
  assert.equal(state.jobs.size, 2);
  assert.equal(state.events.at(-1)[1].items[0].idempotent, true);
  assert.equal(state.events.at(-1)[1].items[1].idempotent, false);
});

test('cancellation stops before the next admission and deletes the current transient upload', async () => {
  const controller = new AbortController();
  const state = fixture({ onCommit: async () => controller.abort() });
  await assert.rejects(runAutomationCliBatchCommand(state.application, state.command(), {}, state.runtime, controller.signal), { code: 'JOB_CANCELLED' });
  assert.deepEqual(state.events.filter((event) => event[0] === 'upload'), [['upload', 'one.pdf']]);
  assert.deepEqual(state.events.filter((event) => event[0] === 'delete'), [['delete', 'document-one']]);
  assert.equal(state.jobs.size, 1);
});
