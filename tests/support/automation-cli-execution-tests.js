import test from 'node:test';
import {
  assert, createHash, chmod, link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat,
  symlink, writeFile, tmpdir, join, Readable, Writable,
  AutomationSourceStore, AutomationOperationRegistry, AutomationWorker,
  DurableLocalJobQueue, runAutomationCommand, cliRuntime, DocumentStore,
  parseCliArguments, makeTextPdf, AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE, digest, fixture, documentStore, executionStore,
  inspection, ocrOutput, outputCapture, transientOcrStore,
  transientOutputIntentExecution,
} from './automation-execution-fixture.js';

test('CLI submission is idempotent and refuses a full queue before orphaning a source', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const input = join(root, 'input.pdf');
  const other = join(root, 'other.pdf');
  await Promise.all([
    writeFile(input, bytes),
    writeFile(other, makeTextPdf('SECOND SOURCE')),
  ]);
  const store = await new DocumentStore({ root: join(root, 'cli-session') }).initialize();
  t.after(() => store.dispose());
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const queue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_INSPECT_TYPE],
    limits: { maxJobs: 1 },
  }).initialize();
  t.after(() => queue.close().catch(() => {}));
  const registry = new AutomationOperationRegistry();
  const application = { store, automation: { sources, queue, registry } };
  const command = {
    command: 'automation-submit-inspect', input, automationRoot, idempotencyKey: null, output: null,
  };
  const firstOutput = outputCapture();
  await runAutomationCommand(application, command, firstOutput.stream, cliRuntime);
  const first = firstOutput.value();
  assert.equal(first.idempotent, false);
  const repeatOutput = outputCapture();
  await runAutomationCommand(application, command, repeatOutput.stream, cliRuntime);
  assert.equal(repeatOutput.value().job.id, first.job.id);
  assert.equal(repeatOutput.value().idempotent, true);

  const sourceEntries = await readdir(join(automationRoot, 'sources'));
  assert.equal(sourceEntries.length, 1);
  await assert.rejects(runAutomationCommand(application, {
    ...command, input: other,
  }, outputCapture().stream, cliRuntime), { code: 'QUEUE_FULL' });
  assert.deepEqual(await readdir(join(automationRoot, 'sources')), sourceEntries);
  const journal = await readFile(join(automationRoot, 'queue', 'journal.json'), 'utf8');
  assert.equal(journal.includes(input), false);
  assert.equal(journal.includes(other), false);
});

test('CLI enqueues only the fixed OutputIntent automation operation', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const input = join(root, 'input.pdf');
  await writeFile(input, bytes);
  const store = await new DocumentStore({ root: join(root, 'cli-session') }).initialize();
  t.after(() => store.dispose());
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const queue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'),
    allowedJobTypes: [AUTOMATION_OUTPUT_INTENT_TYPE],
  }).initialize();
  t.after(() => queue.close().catch(() => {}));
  const registry = new AutomationOperationRegistry();
  const application = { store, automation: { sources, queue, registry } };
  const capture = outputCapture();
  await runAutomationCommand(application, {
    command: 'automation-submit-output-intent',
    input,
    automationRoot,
    idempotencyKey: null,
    output: null,
  }, capture.stream, cliRuntime);
  const submitted = capture.value();
  assert.equal(submitted.operation, AUTOMATION_OUTPUT_INTENT_TYPE);
  assert.deepEqual(submitted.job.payload, {
    sourceId: submitted.source.id,
    sha256: submitted.source.sha256,
    profile: 'local-ghostscript-default-cmyk-output-intent-v1',
  });
  assert.equal(JSON.stringify(submitted).includes(input), false);
});

test('concurrent same-digest submissions serialize admission before staging when the queue holds one job', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const input = join(root, 'input.pdf');
  await writeFile(input, bytes);
  const store = await new DocumentStore({ root: join(root, 'cli-session') }).initialize();
  t.after(() => store.dispose());
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const queue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_INSPECT_TYPE],
    limits: { maxJobs: 1 },
  }).initialize();
  t.after(() => queue.close().catch(() => {}));
  let staged = 0;
  const serializedSources = {
    stageDocument: async (options) => {
      staged += 1;
      return sources.stageDocument(options);
    },
    commit: (source) => sources.commit(source),
    discardCreated: (source) => sources.discardCreated(source),
    openVerified: (id, sha256) => sources.openVerified(id, sha256),
  };
  const application = {
    store,
    automation: { sources: serializedSources, queue, registry: new AutomationOperationRegistry() },
  };
  const first = runAutomationCommand(application, {
    command: 'automation-submit-inspect', input, automationRoot, idempotencyKey: 'first', output: null,
  }, outputCapture().stream, cliRuntime);
  const second = runAutomationCommand(application, {
    command: 'automation-submit-inspect', input, automationRoot, idempotencyKey: 'second', output: null,
  }, outputCapture().stream, cliRuntime);

  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.reason?.code === 'QUEUE_FULL').length, 1);
  assert.equal(staged, 1);
  const entries = await readdir(join(automationRoot, 'sources'));
  assert.equal(entries.length, 1);
  const job = (await queue.admission('first')).existing ?? (await queue.admission('second')).existing;
  const opened = await sources.openVerified(job.payload.sourceId, job.payload.sha256);
  opened.stream.destroy();
});

test('submission cancellation after source staging removes the exact source before enqueue', async (t) => {
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
  const controller = new AbortController();
  const cancellingSources = {
    async stageDocument(options) {
      assert.equal(options.signal, controller.signal);
      const source = await sources.stageDocument(options);
      controller.abort();
      return source;
    },
    commit: (source) => sources.commit(source),
    discardCreated: (source) => sources.discardCreated(source),
    openVerified: (id, sha256) => sources.openVerified(id, sha256),
  };
  const application = {
    store,
    automation: {
      sources: cancellingSources, queue, registry: new AutomationOperationRegistry(),
    },
  };

  await assert.rejects(runAutomationCommand(application, {
    command: 'automation-submit-inspect', input, automationRoot,
    idempotencyKey: 'cancel-after-stage', output: null,
  }, outputCapture().stream, cliRuntime, controller.signal), { code: 'JOB_CANCELLED' });
  assert.deepEqual(await readdir(join(automationRoot, 'sources')), []);
  const journal = JSON.parse(await readFile(join(automationRoot, 'queue', 'journal.json'), 'utf8'));
  assert.deepEqual(journal.jobs, []);
});

test('automation CLI commands require a root and use exact bounded argument shapes', () => {
  assert.deepEqual(parseCliArguments(['automation-run', '--automation-root', 'private']), { command: 'automation-run', automationRoot: 'private', output: null });
  assert.deepEqual(parseCliArguments(['automation-status', 'job_1', '--automation-root', 'private']), { command: 'automation-status', jobId: 'job_1', automationRoot: 'private', output: null });
  assert.deepEqual(parseCliArguments(['automation-submit-inspect', 'input.pdf', '--automation-root', 'private']), { command: 'automation-submit-inspect', input: 'input.pdf', automationRoot: 'private', idempotencyKey: null, output: null });
  assert.deepEqual(parseCliArguments(['automation-submit-output-intent', 'input.pdf', '--automation-root', 'private']), { command: 'automation-submit-output-intent', input: 'input.pdf', automationRoot: 'private', idempotencyKey: null, output: null });
  assert.deepEqual(parseCliArguments(['automation-submit-full-page-redaction', 'input.pdf', '--pages', '3,1-2,2', '--automation-root', 'private']), { command: 'automation-submit-full-page-redaction', input: 'input.pdf', pages: [1, 2, 3], automationRoot: 'private', idempotencyKey: null, output: null });
  assert.deepEqual(parseCliArguments(['automation-output-list', '--automation-root', 'private']), { command: 'automation-output-list', automationRoot: 'private', output: null });
  assert.deepEqual(parseCliArguments(['automation-output-copy', 'output_1', '--sha256', 'a'.repeat(64), '--automation-root', 'private', '--output', 'copy.pdf']), { command: 'automation-output-copy', automationRoot: 'private', outputId: 'output_1', sha256: 'a'.repeat(64), output: 'copy.pdf' });
  assert.deepEqual(parseCliArguments(['automation-output-delete', 'output_1', '--sha256', 'a'.repeat(64), '--automation-root', 'private']), { command: 'automation-output-delete', automationRoot: 'private', outputId: 'output_1', sha256: 'a'.repeat(64), output: null });
  assert.throws(() => parseCliArguments(['automation-run']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['automation-cancel', '../job', '--automation-root', 'private']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['automation-output-copy', 'output_1', '--sha256', 'A'.repeat(64), '--automation-root', 'private', '--output', 'copy.pdf']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['automation-output-delete', '../output', '--sha256', 'a'.repeat(64), '--automation-root', 'private']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['automation-submit-output-intent', 'input.pdf', '--profile', 'custom', '--automation-root', 'private']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['automation-submit-full-page-redaction', 'input.pdf', '--pages', '1-101', '--automation-root', 'private']), { code: 'CLI_INVALID_OPTION' });
  assert.throws(() => parseCliArguments(['automation-submit-full-page-redaction', 'input.pdf', '--pages', '2-1', '--automation-root', 'private']), { code: 'CLI_INVALID_OPTION' });
});
