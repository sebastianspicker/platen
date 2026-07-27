import test from 'node:test';
import {
  assert, writeFile, readdir, readFile, join,
  AutomationSourceStore, AutomationOperationRegistry, AutomationWorker,
  DurableLocalJobQueue, runAutomationCommand, cliRuntime, DocumentStore,
  parseCliArguments, fixture, documentStore, executionStore,
  inspection, outputCapture, transientOutputIntentExecution,
  AUTOMATION_INSPECT_TYPE, AUTOMATION_OUTPUT_INTENT_TYPE,
} from './support/automation-execution-fixture.js';
import {
  AUTOMATION_INSPECT_PRESET, AUTOMATION_OCR_PRESET,
  AUTOMATION_OUTPUT_INTENT_PRESET, AUTOMATION_PRESET_IDS,
  automationPresetDescriptor, expandAutomationPreset, presetPayload,
} from '../scripts/host/automation/automation-operation-contract.mjs';

const sourcePayload = Object.freeze({
  sourceId: 'source_1',
  sha256: 'a'.repeat(64),
});

test('named presets are a tiny immutable versioned registry with exact payloads', () => {
  assert.deepEqual(AUTOMATION_PRESET_IDS, [
    AUTOMATION_INSPECT_PRESET,
    AUTOMATION_OCR_PRESET,
    AUTOMATION_OUTPUT_INTENT_PRESET,
  ].sort());
  assert.equal(automationPresetDescriptor(AUTOMATION_INSPECT_PRESET).version, 1);
  assert.deepEqual(expandAutomationPreset({
    preset: AUTOMATION_OCR_PRESET, ...sourcePayload,
  }), {
    ...sourcePayload,
    language: 'eng', cleanupPreset: 'document', segmentation: 'auto', userDictionary: [],
  });
  assert.deepEqual(presetPayload({
    preset: AUTOMATION_OUTPUT_INTENT_PRESET, ...sourcePayload,
  }), {
    preset: AUTOMATION_OUTPUT_INTENT_PRESET, ...sourcePayload,
  });
  assert.throws(() => automationPresetDescriptor('unknown-preset'), {
    code: 'INVALID_AUTOMATION_OPERATION',
  });
  assert.throws(() => presetPayload({
    preset: AUTOMATION_INSPECT_PRESET, ...sourcePayload, profile: 'custom',
  }), { code: 'INVALID_AUTOMATION_OPERATION' });
  for (const key of ['steps', 'condition', 'variables', 'sequence']) {
    assert.throws(() => presetPayload({
      preset: AUTOMATION_INSPECT_PRESET, ...sourcePayload, [key]: [],
    }), { code: 'INVALID_AUTOMATION_OPERATION' });
  }
  const accessor = { ...sourcePayload };
  Object.defineProperty(accessor, 'preset', {
    enumerable: true, get: () => AUTOMATION_INSPECT_PRESET,
  });
  assert.throws(() => presetPayload(accessor), { code: 'INVALID_AUTOMATION_OPERATION' });
  const polluted = Object.create({ polluted: true });
  Object.assign(polluted, { preset: AUTOMATION_INSPECT_PRESET, ...sourcePayload });
  assert.throws(() => presetPayload(polluted), { code: 'INVALID_AUTOMATION_OPERATION' });
  const proxied = new Proxy({ preset: AUTOMATION_INSPECT_PRESET, ...sourcePayload }, {
    ownKeys() { throw new Error('proxy trap'); },
  });
  assert.throws(() => presetPayload(proxied), { code: 'INVALID_AUTOMATION_OPERATION' });
});

test('conflicting direct preset fields are rejected before source access', async () => {
  const registry = new AutomationOperationRegistry();
  let opened = false;
  await assert.rejects(registry.execute(AUTOMATION_OUTPUT_INTENT_TYPE, {
    preset: AUTOMATION_OUTPUT_INTENT_PRESET,
    ...sourcePayload,
    profile: 'caller-selected-profile',
  }, {
    sources: {
      async openVerified() { opened = true; },
      async stagePromotedArtifact() {}, async discardCreatedOutput() {},
    },
    store: {
      async createDocument() {}, async deleteDocument() {},
      getArtifact() {},
    },
    service: {},
    outputIntentService: { async assign() {} },
  }), { code: 'INVALID_AUTOMATION_OPERATION' });
  assert.equal(opened, false);
});

test('preset CLI accepts exactly one immutable preset or operation selection', () => {
  assert.deepEqual(parseCliArguments([
    'automation-submit', 'input.pdf', '--automation-root', 'private',
    '--preset', AUTOMATION_INSPECT_PRESET,
  ]), {
    command: 'automation-submit', input: 'input.pdf', automationRoot: 'private',
    preset: AUTOMATION_INSPECT_PRESET, idempotencyKey: null, output: null,
  });
  assert.deepEqual(parseCliArguments([
    'automation-submit', 'input.pdf', '--automation-root', 'private',
    '--operation', 'ocr', '--language', 'eng', '--cleanup', 'document', '--segmentation', 'auto',
  ]), {
    command: 'automation-submit', input: 'input.pdf', automationRoot: 'private',
    operation: 'ocr', idempotencyKey: null, output: null,
    language: 'eng', cleanupPreset: 'document', segmentation: 'auto',
  });
  assert.deepEqual(parseCliArguments([
    'automation-submit', 'input.pdf', '--automation-root', 'private',
    '--operation', 'full-page-redaction', '--pages', '3,1-2',
  ]), {
    command: 'automation-submit', input: 'input.pdf', automationRoot: 'private',
    operation: 'full-page-redaction', idempotencyKey: null, output: null, pages: [1, 2, 3],
  });
  for (const args of [
    ['automation-submit', 'input.pdf', '--automation-root', 'private'],
    ['automation-submit', 'input.pdf', '--automation-root', 'private', '--operation', 'inspect', '--preset', AUTOMATION_INSPECT_PRESET],
    ['automation-submit', 'input.pdf', '--automation-root', 'private', '--preset', 'not-allowlisted'],
    ['automation-submit', 'input.pdf', '--automation-root', 'private', '--preset', AUTOMATION_INSPECT_PRESET, '--language', 'eng'],
    ['automation-submit', 'input.pdf', '--automation-root', 'private', '--operation', 'inspect', '--pages', '1'],
    ['automation-submit', 'input.pdf', '--automation-root', 'private', '--operation', 'full-page-redaction'],
  ]) assert.throws(() => parseCliArguments(args), { code: 'CLI_INVALID_OPTION' });
});

test('named inspect preset survives durable queue restart and executes once', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const session = await documentStore(join(root, 'session'), bytes);
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const source = await sources.stageDocument({ store: session.store, documentId: session.document.id });
  await sources.commit(source);
  await session.store.dispose();
  const queueOptions = {
    root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_INSPECT_TYPE],
  };
  const registry = new AutomationOperationRegistry();
  const firstQueue = await new DurableLocalJobQueue(queueOptions).initialize();
  const request = registry.enqueuePresetRequest(source, AUTOMATION_INSPECT_PRESET);
  const queued = await firstQueue.enqueue({ ...request, idempotencyKey: 'preset-restart' });
  await firstQueue.close();

  const reopenedSources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const reopenedQueue = await new DurableLocalJobQueue(queueOptions).initialize();
  t.after(() => reopenedQueue.close().catch(() => {}));
  const persisted = await reopenedQueue.get(queued.job.id);
  assert.deepEqual(persisted.payload, {
    preset: AUTOMATION_INSPECT_PRESET, sourceId: source.id, sha256: source.sha256,
  });
  const store = executionStore();
  let calls = 0;
  const worker = new AutomationWorker({
    queue: reopenedQueue, registry, sources: reopenedSources, store,
    service: { async inspect() { calls += 1; return inspection; } },
  });
  t.after(() => worker.close().catch(() => {}));
  const run = await worker.runOnce();
  assert.equal(run.receipt.status, 'completed');
  assert.equal(run.receipt.result.preset, AUTOMATION_INSPECT_PRESET);
  assert.equal(Object.isFrozen(run.receipt.result), true);
  assert.equal(run.receipt.result.preset.length <= 128, true);
  assert.equal(calls, 1);
  assert.equal((await reopenedQueue.receipt(queued.job.id)).result.preset, AUTOMATION_INSPECT_PRESET);
});

test('named OutputIntent preset executes with a bounded receipt and durable output', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const session = await documentStore(join(root, 'session'), bytes);
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const source = await sources.stageDocument({ store: session.store, documentId: session.document.id });
  await sources.commit(source);
  await session.store.dispose();
  const artifactBytes = Buffer.from('%PDF-1.7\nOUTPUT INTENT\n');
  const artifactPath = join(root, 'output-intent.pdf');
  await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
  const execution = transientOutputIntentExecution(source, artifactPath, artifactBytes);
  const queue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_OUTPUT_INTENT_TYPE],
  }).initialize();
  t.after(() => queue.close().catch(() => {}));
  const registry = new AutomationOperationRegistry();
  const queued = await queue.enqueue({
    ...registry.enqueuePresetRequest(source, AUTOMATION_OUTPUT_INTENT_PRESET),
    idempotencyKey: 'preset-output-intent',
  });
  const worker = new AutomationWorker({
    queue, registry, sources, store: execution.store, service: {},
    outputIntentService: execution.outputIntentService,
  });
  t.after(() => worker.close().catch(() => {}));
  const run = await worker.runOnce();
  assert.equal(run.receipt.status, 'completed');
  assert.equal(run.receipt.result.preset, AUTOMATION_OUTPUT_INTENT_PRESET);
  assert.equal(run.receipt.result.operation, AUTOMATION_OUTPUT_INTENT_TYPE);
  assert.equal((await queue.receipt(queued.job.id)).result.preset, AUTOMATION_OUTPUT_INTENT_PRESET);
  assert.equal((await sources.listOutputs()).length, 1);
});

test('preset idempotency is deterministic and invalid presets leave no durable artifacts', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const input = join(root, 'input.pdf');
  await writeFile(input, bytes);
  const store = await new DocumentStore({ root: join(root, 'cli-session') }).initialize();
  t.after(() => store.dispose());
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const queue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_INSPECT_TYPE],
  }).initialize();
  t.after(() => queue.close().catch(() => {}));
  const application = { store, automation: {
    sources, queue, registry: new AutomationOperationRegistry(),
  } };
  const command = {
    command: 'automation-submit', input, automationRoot,
    preset: AUTOMATION_INSPECT_PRESET, idempotencyKey: null, output: null,
  };
  const first = outputCapture();
  await runAutomationCommand(application, command, first.stream, cliRuntime);
  const firstValue = first.value();
  const repeat = outputCapture();
  await runAutomationCommand(application, command, repeat.stream, cliRuntime);
  const repeatValue = repeat.value();
  assert.equal(repeatValue.idempotent, true);
  assert.equal(repeatValue.job.id, firstValue.job.id);
  assert.equal(repeatValue.job.payload.preset, AUTOMATION_INSPECT_PRESET);

  await assert.rejects(runAutomationCommand(application, {
    ...command, preset: 'unknown-preset', idempotencyKey: 'invalid-preset',
  }, outputCapture().stream, cliRuntime), { code: 'INVALID_AUTOMATION_OPERATION' });
  assert.deepEqual(await readdir(join(automationRoot, 'sources')), [firstValue.source.id]);
  assert.deepEqual((JSON.parse(await readFile(join(automationRoot, 'queue', 'journal.json')))).jobs.length, 1);
  assert.deepEqual(await sources.listOutputs(), []);
});

test('preset cancellation reaches the durable terminal state without engine output', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const session = await documentStore(join(root, 'session'), bytes);
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const source = await sources.stageDocument({ store: session.store, documentId: session.document.id });
  await sources.commit(source);
  await session.store.dispose();
  const queue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_INSPECT_TYPE],
  }).initialize();
  t.after(() => queue.close().catch(() => {}));
  const registry = new AutomationOperationRegistry();
  const queued = await queue.enqueue({
    ...registry.enqueuePresetRequest(source, AUTOMATION_INSPECT_PRESET),
    idempotencyKey: 'preset-cancel',
  });
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const worker = new AutomationWorker({
    queue, registry, sources, store: executionStore(),
    service: { inspect(_id, { signal }) {
      startedResolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    } },
  });
  t.after(() => worker.close().catch(() => {}));
  const controller = new AbortController();
  const running = worker.runOnce({ signal: controller.signal });
  await started;
  controller.abort();
  const result = await running;
  assert.equal(result.receipt.status, 'cancelled');
  assert.equal((await queue.receipt(queued.job.id)).status, 'cancelled');
  assert.deepEqual(await sources.listOutputs(), []);
});
