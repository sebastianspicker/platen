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

test('automation OCR removes a staged durable output when queue completion fails', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const session = await documentStore(join(root, 'session'), bytes);
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const source = await sources.stageDocument({
    store: session.store, documentId: session.document.id,
  });
  await sources.commit(source);
  await session.store.dispose();
  const artifactBytes = makeTextPdf('FAILED OCR OUTPUT');
  const artifactPath = join(root, 'transient-failed-ocr.pdf');
  await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
  const execution = transientOcrStore(source, artifactPath, artifactBytes);
  const durableQueue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_OCR_TYPE],
  }).initialize();
  t.after(() => durableQueue.close().catch(() => {}));
  const registry = new AutomationOperationRegistry();
  await durableQueue.enqueue({
    ...registry.enqueueOcrRequest(source), idempotencyKey: 'failed-durable-output',
  });
  const queue = {
    claim: (...args) => durableQueue.claim(...args),
    renew: (...args) => durableQueue.renew(...args),
    complete: async () => { throw new Error('queue completion failed'); },
    fail: (...args) => durableQueue.fail(...args),
    cancel: (...args) => durableQueue.cancel(...args),
    get: (...args) => durableQueue.get(...args),
    receipt: (...args) => durableQueue.receipt(...args),
  };
  const worker = new AutomationWorker({
    queue, registry, sources, store: execution.store, service: execution.service,
  });
  t.after(() => worker.close().catch(() => {}));
  const run = await worker.runOnce();
  assert.equal(run.receipt.status, 'failed');
  assert.deepEqual(await readdir(join(automationRoot, 'outputs')), []);
});

test('automation OCR cancellation after durable staging removes the uncommitted output', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const session = await documentStore(join(root, 'session'), bytes);
  const durableSources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const source = await durableSources.stageDocument({
    store: session.store, documentId: session.document.id,
  });
  durableSources.commit(source);
  await session.store.dispose();
  const artifactBytes = makeTextPdf('CANCELLED OCR OUTPUT');
  const artifactPath = join(root, 'transient-cancelled-ocr.pdf');
  await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
  const execution = transientOcrStore(source, artifactPath, artifactBytes);
  const queue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_OCR_TYPE],
  }).initialize();
  t.after(() => queue.close().catch(() => {}));
  const registry = new AutomationOperationRegistry();
  const queued = await queue.enqueue({
    ...registry.enqueueOcrRequest(source), idempotencyKey: 'cancelled-durable-output',
  });
  const controller = new AbortController();
  const sources = {
    openVerified: (...args) => durableSources.openVerified(...args),
    async stagePromotedArtifact(options) {
      const output = await durableSources.stagePromotedArtifact(options);
      controller.abort(new Error('cancel after durable staging'));
      return output;
    },
    commitOutput: (output) => durableSources.commitOutput(output),
    discardCreatedOutput: (output) => durableSources.discardCreatedOutput(output),
  };
  const worker = new AutomationWorker({
    queue, registry, sources, store: execution.store, service: execution.service,
  });
  t.after(() => worker.close().catch(() => {}));
  const run = await worker.runOnce({ signal: controller.signal });
  assert.equal(run.receipt.status, 'cancelled');
  assert.equal((await queue.receipt(queued.job.id)).status, 'cancelled');
  assert.deepEqual(await readdir(join(automationRoot, 'outputs')), []);
});

test('automation output lifecycle lists metadata, copies exclusively, and deletes by exact digest', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const session = await documentStore(join(root, 'session'), bytes);
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const source = await sources.stageDocument({
    store: session.store, documentId: session.document.id,
  });
  await sources.commit(source);
  const artifactBytes = makeTextPdf('OUTPUT LIFECYCLE');
  const artifactPath = join(root, 'promoted-artifact.pdf');
  await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
  const artifact = {
    id: '44444444-4444-4444-8444-444444444444',
    documentId: session.document.id,
    mediaType: 'application/pdf',
    size: artifactBytes.length,
    sha256: digest(artifactBytes),
    filePath: artifactPath,
  };
  const store = { getArtifact: (id) => {
    assert.equal(id, artifact.id);
    return Object.freeze({ ...artifact });
  } };
  const durable = await sources.stagePromotedArtifact({
    store, artifactId: artifact.id, source,
  });
  await sources.commitOutput(durable);
  await session.store.dispose();
  await rm(artifactPath);

  assert.deepEqual(await sources.getOutputMetadata(durable.id), durable);
  assert.deepEqual(await sources.listOutputs(), [durable]);
  const application = { automation: { sources } };
  const listing = outputCapture();
  await runAutomationCommand(application, {
    command: 'automation-output-list', automationRoot, output: null,
  }, listing.stream, cliRuntime);
  const listed = listing.value();
  assert.equal(listed.count, 1);
  assert.deepEqual(listed.outputs, [durable]);
  assert.equal(JSON.stringify(listed).includes(automationRoot), false);
  assert.equal(JSON.stringify(listed).includes('output.pdf'), false);

  const copiedPath = join(root, 'copied-output.pdf');
  const copiedReceipt = outputCapture();
  await runAutomationCommand(application, {
    command: 'automation-output-copy', automationRoot,
    outputId: durable.id, sha256: durable.sha256, output: copiedPath,
  }, copiedReceipt.stream, cliRuntime);
  assert.deepEqual(await readFile(copiedPath), artifactBytes);
  assert.equal((await stat(copiedPath)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(copiedReceipt.value()).includes(copiedPath), false);
  await assert.rejects(runAutomationCommand(application, {
    command: 'automation-output-copy', automationRoot,
    outputId: durable.id, sha256: durable.sha256, output: copiedPath,
  }, outputCapture().stream, cliRuntime), { code: 'CLI_OUTPUT_EXISTS' });

  const symlinkTarget = join(root, 'must-remain.txt');
  const symlinkOutput = join(root, 'output-link.pdf');
  await writeFile(symlinkTarget, 'unchanged');
  await symlink(symlinkTarget, symlinkOutput);
  await assert.rejects(runAutomationCommand(application, {
    command: 'automation-output-copy', automationRoot,
    outputId: durable.id, sha256: durable.sha256, output: symlinkOutput,
  }, outputCapture().stream, cliRuntime), { code: 'CLI_OUTPUT_EXISTS' });
  assert.equal(await readFile(symlinkTarget, 'utf8'), 'unchanged');

  await assert.rejects(runAutomationCommand(application, {
    command: 'automation-output-delete', automationRoot,
    outputId: durable.id, sha256: '0'.repeat(64), output: null,
  }, outputCapture().stream, cliRuntime), { code: 'AUTOMATION_OUTPUT_MISMATCH' });
  assert.deepEqual(await sources.listOutputs(), [durable]);
  const deletion = outputCapture();
  await runAutomationCommand(application, {
    command: 'automation-output-delete', automationRoot,
    outputId: durable.id, sha256: durable.sha256, output: null,
  }, deletion.stream, cliRuntime);
  assert.equal(deletion.value().deleted, true);
  assert.deepEqual(await sources.listOutputs(), []);
  assert.deepEqual(await readFile(copiedPath), artifactBytes);
});

test('worker renews leases, serializes execution, backs off busy jobs, and cancels signals', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const session = await documentStore(join(root, 'session'), bytes);
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const source = await sources.stageDocument({ store: session.store, documentId: session.document.id });
  await session.store.dispose();
  const queue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_INSPECT_TYPE],
  }).initialize();
  t.after(() => queue.close().catch(() => {}));
  const registry = new AutomationOperationRegistry();
  const store = executionStore();

  const renewed = await queue.enqueue({
    ...registry.enqueueRequest(source), idempotencyKey: 'renewed',
  });
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  let renewedLease;
  const leaseRenewed = new Promise((resolve) => { renewedLease = resolve; });
  const renewingQueue = {
    claim: (...args) => queue.claim(...args),
    renew: async (...args) => {
      const job = await queue.renew(...args);
      renewedLease();
      return job;
    },
    complete: (...args) => queue.complete(...args),
    fail: (...args) => queue.fail(...args),
    cancel: (...args) => queue.cancel(...args),
    get: (...args) => queue.get(...args),
    receipt: (...args) => queue.receipt(...args),
  };
  const renewingWorker = new AutomationWorker({
    queue: renewingQueue, registry, sources, store, leaseMs: 1_000, heartbeatMs: 10,
    service: { async inspect() { started(); await leaseRenewed; return inspection; } },
  });
  const running = renewingWorker.runOnce();
  await began;
  await assert.rejects(renewingWorker.runOnce(), { code: 'AUTOMATION_WORKER_BUSY' });
  assert.equal((await running).receipt.status, 'completed');
  assert.equal((await queue.get(renewed.job.id)).attempts, 1);
  await renewingWorker.close();

  const busy = await queue.enqueue({
    ...registry.enqueueRequest(source), idempotencyKey: 'busy',
  });
  const busyWorker = new AutomationWorker({
    queue, registry, sources, store,
    service: { async inspect() { const error = new Error('busy'); error.code = 'ENGINE_BUSY'; throw error; } },
  });
  await busyWorker.runOnce();
  const retry = await queue.get(busy.job.id);
  assert.equal(retry.status, 'pending');
  assert.ok(retry.retry.notBefore > retry.updatedAt);
  await queue.cancel(busy.job.id);
  await busyWorker.close();

  const cancellable = await queue.enqueue({
    ...registry.enqueueRequest(source), idempotencyKey: 'cancelled',
  });
  let inspectionStarted;
  const inspectionBegan = new Promise((resolve) => { inspectionStarted = resolve; });
  const controller = new AbortController();
  const cancellingWorker = new AutomationWorker({
    queue, registry, sources, store,
    service: { inspect(_id, { signal }) { inspectionStarted(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } },
  });
  const cancelledRun = cancellingWorker.runOnce({ signal: controller.signal });
  await inspectionBegan;
  controller.abort(new Error('test cancellation'));
  assert.equal((await cancelledRun).receipt.status, 'cancelled');
  assert.equal((await queue.receipt(cancellable.job.id)).status, 'cancelled');
  await cancellingWorker.close();
});
