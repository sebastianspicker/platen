import test from 'node:test';
import {
  assert, createHash, chmod, link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat,
  symlink, writeFile, tmpdir, join, Readable, Writable,
  AutomationSourceStore, AutomationOperationRegistry, AutomationWorker,
  DurableLocalJobQueue, runAutomationCommand, cliRuntime, DocumentStore,
  parseCliArguments, makeTextPdf, AUTOMATION_INSPECT_TYPE, AUTOMATION_OCR_TYPE,
  AUTOMATION_OUTPUT_INTENT_TYPE, digest, fixture, documentStore, executionStore,
  inspection, ocrOutput, outputCapture, transientOcrStore,
  transientOutputIntentExecution, fullPageRedactionOutput,
} from './automation-execution-fixture.js';
test('full-page redaction automation chains pages and retains one final durable output', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const session = await documentStore(join(root, 'session'), bytes);
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const source = await sources.stageDocument({ store: session.store, documentId: session.document.id });
  await sources.commit(source);
  await session.store.dispose();
  const registry = new AutomationOperationRegistry();
  const pagesSeen = [];
  const batchCalls = [];
  const artifacts = new Map();
  let sequence = 0;
  const store = {
    async createDocument({ stream }) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const content = Buffer.concat(chunks);
      const id = `document_${++sequence}`;
      const value = { id, sha256: digest(content), size: content.length };
      return value;
    },
    getArtifact(id) {
      const value = artifacts.get(id);
      assert(value, `missing artifact ${id}`);
      return Object.freeze({ ...value });
    },
    async deleteDocument() {},
  };
  const fullPageRedaction = {
    async update(documentId, request) {
      pagesSeen.push({ documentId, ...request });
      const nextBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64 + request.page)]);
      const artifactPath = join(root, `artifact-${request.page}.pdf`);
      await writeFile(artifactPath, nextBytes, { mode: 0o600 });
      const output = fullPageRedactionOutput({
        sourceSha256: request.sourceSha256,
        documentId,
        page: request.page,
        artifactPath,
        artifactBytes: nextBytes,
      });
      artifacts.set(output.artifact.id, { ...output.artifact, filePath: artifactPath });
      return output;
    },
    async updateBatch(documentId, request) {
      batchCalls.push({ documentId, ...request });
      const nextBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64 + request.pages.length)]);
      const artifactPath = join(root, 'artifact-batch.pdf');
      await writeFile(artifactPath, nextBytes, { mode: 0o600 });
      const output = fullPageRedactionOutput({ sourceSha256: request.sourceSha256, documentId, page: request.pages.at(-1), pages: request.pages, artifactPath, artifactBytes: nextBytes });
      artifacts.set(output.artifact.id, { ...output.artifact, filePath: artifactPath });
      return output;
    },
  };
  const finalBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64 + 2)]);
  const durableOutput = {
    id: 'output_1', size: finalBytes.length, sha256: digest(finalBytes),
    sourceId: source.id, sourceSha256: source.sha256,
  };
  const automationSources = {
    async openVerified(id, sha256) {
      assert.equal(id, source.id);
      assert.equal(sha256, source.sha256);
      return { ...source, stream: Readable.from([bytes]) };
    },
    async stagePromotedArtifact({ artifactId }) {
      assert.equal(artifactId, '44444444-4444-4244-8444-444444444444');
      return durableOutput;
    },
    async discardCreatedOutput() {},
  };
  const request = registry.enqueueFullPageRedactionRequest(source, { pages: [1, 2] });
  assert.deepEqual(request.payload.pages, [1, 2]);
  assert.throws(() => registry.enqueueFullPageRedactionRequest(source, { pages: [2, 1] }), {
    code: 'INVALID_AUTOMATION_OPERATION',
  });
  const execution = await registry.execute(request.type, request.payload, {
    sources: automationSources,
    store,
    service: {},
    fullPageRedaction,
  });
  assert.deepEqual(batchCalls, [{ documentId: 'document_1', profile: 'local-object-full-page-redaction-batch-v1', sourceSha256: source.sha256, pages: [1, 2] }]);
  assert.deepEqual(pagesSeen, []);
  assert.deepEqual(execution.receipt.pages, [1, 2]);
  assert.deepEqual(execution.receipt.durableOutput, {
    id: durableOutput.id, size: durableOutput.size, sha256: durableOutput.sha256,
  });
  assert.equal(JSON.stringify(execution.receipt).includes(root), false);
  t.after(() => rm(root, { recursive: true, force: true }));
});
test('multi-page automation fails closed when the atomic batch service is unavailable', async () => {
  const registry = new AutomationOperationRegistry();
  const source = { id: 'source_1', sha256: 'a'.repeat(64), size: 9 };
  const request = registry.enqueueFullPageRedactionRequest(source, { pages: [1, 2] });
  await assert.rejects(registry.execute(request.type, request.payload, {
    sources: { async openVerified() { return { ...source, stream: Readable.from([Buffer.from('%PDF-1.7\n')]) }; }, async stagePromotedArtifact() {}, async discardCreatedOutput() {} },
    store: { async createDocument() { return { id: 'document_1', sha256: source.sha256, size: source.size }; }, async deleteDocument() {}, getArtifact() {} },
    service: {}, fullPageRedaction: { async update() { throw new Error('must not chain'); } },
  }), { code: 'AUTOMATION_FULL_PAGE_REDACTION_BATCH_UNAVAILABLE' });
});
test('automation sources persist private descriptor-bound copies and reopen safely', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const session = await documentStore(join(root, 'session'), bytes);
  t.after(() => session.store.dispose());
  const sources = await new AutomationSourceStore({
    root: automationRoot, idFactory: () => 'source_1',
  }).initialize();
  const staged = await sources.stageDocument({
    store: session.store, documentId: session.document.id,
  });
  assert.deepEqual(Object.keys(staged).sort(), ['id', 'sha256', 'size']);
  const sourceDirectory = join(automationRoot, 'sources', staged.id);
  const recordText = await readFile(join(sourceDirectory, 'record.json'), 'utf8');
  assert.equal(recordText.includes(session.store.getSourcePath(session.document.id)), false);
  assert.equal((await stat(join(sourceDirectory, 'source.pdf'))).mode & 0o777, 0o400);
  assert.equal((await stat(join(sourceDirectory, 'record.json'))).mode & 0o777, 0o400);
  assert.equal((await sources.stageDocument({
    store: session.store, documentId: session.document.id,
  })).id, staged.id);
  const reopened = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const verified = await reopened.openVerified(staged.id, staged.sha256);
  const chunks = [];
  for await (const chunk of verified.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test('automation sources reject links, record corruption, and ID collisions without deleting data', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const first = await documentStore(join(root, 'first-session'), bytes);
  const second = await documentStore(
    join(root, 'second-session'), makeTextPdf('DIFFERENT AUTOMATION SOURCE'),
  );
  t.after(() => Promise.all([first.store.dispose(), second.store.dispose()]));
  const sources = await new AutomationSourceStore({
    root: automationRoot, idFactory: () => 'same_id',
  }).initialize();
  const staged = await sources.stageDocument({ store: first.store, documentId: first.document.id });
  await assert.rejects(sources.stageDocument({
    store: second.store, documentId: second.document.id,
  }), { code: 'INVALID_AUTOMATION_SOURCE_ID' });
  const original = await sources.openVerified(staged.id, staged.sha256);
  original.stream.destroy();

  const sourcePath = join(automationRoot, 'sources', staged.id, 'source.pdf');
  const hardLink = join(root, 'hard-link.pdf');
  await link(sourcePath, hardLink);
  await assert.rejects(sources.openVerified(staged.id, staged.sha256), {
    code: 'AUTOMATION_SOURCE_CORRUPT',
  });
  await rm(hardLink);
  const saved = join(root, 'saved-source.pdf');
  await rename(sourcePath, saved);
  await symlink(saved, sourcePath);
  await assert.rejects(sources.openVerified(staged.id, staged.sha256), {
    code: 'AUTOMATION_SOURCE_CORRUPT',
  });
  await rm(sourcePath);
  await rename(saved, sourcePath);

  const recordPath = join(automationRoot, 'sources', staged.id, 'record.json');
  await chmod(recordPath, 0o600);
  await writeFile(recordPath, '{"unsafe":true}');
  await assert.rejects(sources.openVerified(staged.id, staged.sha256), {
    code: 'AUTOMATION_SOURCE_CORRUPT',
  });
});

test('queued inspection survives close and executes once after a fresh store restart', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const firstSession = await documentStore(join(root, 'session-one'), bytes);
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const source = await sources.stageDocument({
    store: firstSession.store, documentId: firstSession.document.id,
  });
  const queueOptions = {
    root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_INSPECT_TYPE],
  };
  const firstQueue = await new DurableLocalJobQueue(queueOptions).initialize();
  const registry = new AutomationOperationRegistry();
  const queued = await firstQueue.enqueue({
    ...registry.enqueueRequest(source), idempotencyKey: 'restart-inspect',
  });
  await firstQueue.close();
  await firstSession.store.dispose();

  const reopenedSources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const reopenedQueue = await new DurableLocalJobQueue(queueOptions).initialize();
  t.after(() => reopenedQueue.close().catch(() => {}));
  const store = executionStore();
  let calls = 0;
  const worker = new AutomationWorker({
    queue: reopenedQueue, registry, sources: reopenedSources, store,
    service: { async inspect() { calls += 1; return inspection; } },
  });
  t.after(() => worker.close().catch(() => {}));
  const run = await worker.runOnce();
  assert.equal(run.receipt.status, 'completed');
  assert.deepEqual(run.receipt.result, {
    schemaVersion: 1,
    operation: AUTOMATION_INSPECT_TYPE,
    sourceSha256: source.sha256,
    sourceBytes: bytes.length,
    pageCount: 1,
    pdfVersion: '1.7',
    encrypted: false,
    tagged: false,
    optimized: false,
  });
  assert.equal(calls, 1);
  assert.equal(store.documents.size, 0);
  assert.equal((await reopenedQueue.receipt(queued.job.id)).status, 'completed');
});

test('automation OCR rejects an artifact bound to a different transient document', async () => {
  const sourceSha256 = 'a'.repeat(64);
  const transientDocumentId = '66666666-6666-4666-8666-666666666666';
  const source = { id: 'source_1', sha256: sourceSha256, size: 12 };
  const registry = new AutomationOperationRegistry();
  const output = ocrOutput({ sourceSha256, documentId: transientDocumentId, artifactDocumentId: '77777777-7777-4777-8777-777777777777' });
  const sources = {
    async openVerified() { return { ...source, stream: Readable.from([Buffer.from('%PDF-1.7\n')]), }; },
    async stagePromotedArtifact() { throw new Error('invalid OCR output must not be staged'); },
    async discardCreatedOutput() {},
  };
  const store = {
    async createDocument() { return { id: transientDocumentId, sha256: sourceSha256, size: source.size }; },
    getArtifact() { throw new Error('invalid OCR output must not read an artifact'); },
    async deleteDocument() {},
  };
  await assert.rejects(registry.execute(AUTOMATION_OCR_TYPE, {
    sourceId: source.id, sha256: source.sha256, language: 'eng',
    cleanupPreset: 'document', segmentation: 'auto', userDictionary: [],
  }, {
    sources, store, service: { async ocrDocument() { return output; } },
  }), { code: 'AUTOMATION_RESULT_INVALID', status: 502 });
});

test('automation OCR retains exact verified output bytes after transient cleanup', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const session = await documentStore(join(root, 'session'), bytes);
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const source = await sources.stageDocument({
    store: session.store, documentId: session.document.id,
  });
  await sources.commit(source);
  await session.store.dispose();
  const artifactBytes = makeTextPdf('DURABLE OCR OUTPUT');
  const artifactPath = join(root, 'transient-ocr.pdf');
  await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
  const execution = transientOcrStore(source, artifactPath, artifactBytes);
  const queue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_OCR_TYPE],
  }).initialize();
  t.after(() => queue.close().catch(() => {}));
  const registry = new AutomationOperationRegistry();
  await queue.enqueue({
    ...registry.enqueueOcrRequest(source, { userDictionary: ['PrivateTerm'] }),
    idempotencyKey: 'durable-ocr-output',
  });
  const worker = new AutomationWorker({
    queue, registry, sources, store: execution.store, service: execution.service,
  });
  t.after(() => worker.close().catch(() => {}));
  const run = await worker.runOnce();
  assert.equal(run.receipt.status, 'completed');
  assert.deepEqual(run.receipt.result.durableOutput, {
    id: run.receipt.result.durableOutput.id,
    size: artifactBytes.length,
    sha256: digest(artifactBytes),
  });
  assert.equal('userDictionary' in run.receipt.result, false);
  assert.deepEqual(run.receipt.result.userDictionaryEvidence, {
    termCount: 1,
    digest: createHash('sha256').update('PrivateTerm\n', 'utf8').digest('hex'),
  });
  assert.equal(JSON.stringify(run.receipt.result).includes('PrivateTerm'), false);
  await assert.rejects(stat(artifactPath), { code: 'ENOENT' });

  const reopened = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const retained = await reopened.openOutputVerified(
    run.receipt.result.durableOutput.id,
    run.receipt.result.durableOutput.sha256,
  );
  const chunks = [];
  for await (const chunk of retained.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), artifactBytes);
  const outputDirectory = join(automationRoot, 'outputs', run.receipt.result.durableOutput.id);
  assert.equal((await stat(join(outputDirectory, 'output.pdf'))).mode & 0o777, 0o400);
  assert.equal((await stat(join(outputDirectory, 'record.json'))).mode & 0o777, 0o400);
});

test('automation fixed OutputIntent operation retains source/profile-bound output bytes', async (t) => {
  const { root, automationRoot, bytes } = await fixture(t);
  const session = await documentStore(join(root, 'session'), bytes);
  const sources = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const source = await sources.stageDocument({
    store: session.store, documentId: session.document.id,
  });
  await sources.commit(source);
  await session.store.dispose();
  const artifactBytes = makeTextPdf('DURABLE OUTPUT INTENT');
  const artifactPath = join(root, 'transient-output-intent.pdf');
  await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
  const execution = transientOutputIntentExecution(source, artifactPath, artifactBytes);
  const queue = await new DurableLocalJobQueue({
    root: join(automationRoot, 'queue'),
    allowedJobTypes: [AUTOMATION_OUTPUT_INTENT_TYPE],
  }).initialize();
  t.after(() => queue.close().catch(() => {}));
  const registry = new AutomationOperationRegistry();
  const request = registry.enqueueOutputIntentRequest(source);
  assert.deepEqual(request, {
    type: AUTOMATION_OUTPUT_INTENT_TYPE,
    payload: {
      sourceId: source.id,
      sha256: source.sha256,
      profile: 'local-ghostscript-default-cmyk-output-intent-v1',
    },
  });
  await queue.enqueue({ ...request, idempotencyKey: 'durable-output-intent' });
  const worker = new AutomationWorker({
    queue,
    registry,
    sources,
    store: execution.store,
    service: {},
    outputIntentService: execution.outputIntentService,
  });
  t.after(() => worker.close().catch(() => {}));
  const run = await worker.runOnce();
  assert.equal(run.receipt.status, 'completed');
  assert.equal(run.receipt.result.operation, AUTOMATION_OUTPUT_INTENT_TYPE);
  assert.equal(run.receipt.result.profile, 'local-ghostscript-default-cmyk-output-intent-v1');
  assert.deepEqual(run.receipt.result.profileEvidence, {
    id: 'ghostscript-default-cmyk',
    colorSpace: 'CMYK',
    size: 256,
    sha256: 'e'.repeat(64),
  });
  assert.deepEqual(run.receipt.result.durableOutput, {
    id: run.receipt.result.durableOutput.id,
    size: artifactBytes.length,
    sha256: digest(artifactBytes),
  });
  assert.equal(JSON.stringify(run.receipt.result).includes(root), false);
  assert.equal(JSON.stringify(run.receipt.result).includes('Ghostscript'), false);
  await assert.rejects(stat(artifactPath), { code: 'ENOENT' });
  const retained = await sources.openOutputVerified(
    run.receipt.result.durableOutput.id,
    run.receipt.result.durableOutput.sha256,
  );
  const chunks = [];
  for await (const chunk of retained.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), artifactBytes);
});

test('automation OutputIntent payload rejects caller-selected profiles and extra actions', async () => {
  const registry = new AutomationOperationRegistry();
  const dependencies = {
    sources: {
      async openVerified() { throw new Error('invalid payload must not open a source'); },
      async stagePromotedArtifact() {},
      async discardCreatedOutput() {},
    },
    store: {
      async createDocument() {},
      async deleteDocument() {},
      getArtifact() {},
    },
    service: {},
    outputIntentService: { async assign() {} },
  };
  const base = {
    sourceId: 'source_1',
    sha256: 'a'.repeat(64),
    profile: 'local-ghostscript-default-cmyk-output-intent-v1',
  };
  await assert.rejects(registry.execute(
    AUTOMATION_OUTPUT_INTENT_TYPE,
    { ...base, profile: 'caller-profile' },
    dependencies,
  ), { code: 'INVALID_AUTOMATION_OPERATION' });
  await assert.rejects(registry.execute(
    AUTOMATION_OUTPUT_INTENT_TYPE,
    { ...base, action: 'shell' },
    dependencies,
  ), { code: 'INVALID_AUTOMATION_OPERATION' });
});
