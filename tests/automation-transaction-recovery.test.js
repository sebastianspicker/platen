import test from 'node:test';
import {
  assert, fixture, documentStore, join, rm, writeFile,
  readdir, AutomationSourceStore, DurableLocalJobQueue, AUTOMATION_INSPECT_TYPE,
  AUTOMATION_OCR_TYPE, makeTextPdf, symlink,
  AutomationWorker, AutomationOperationRegistry, executionStore, inspection,
  transientOutputIntentExecution,
} from './support/automation-execution-fixture.js';

async function sourceFixture(t) {
  const context = await fixture(t);
  const session = await documentStore(join(context.root, 'session'), context.bytes);
  const sources = await new AutomationSourceStore({ root: context.automationRoot }).initialize();
  const source = await sources.stageDocument({ store: session.store, documentId: session.document.id });
  await session.store.dispose();
  return { ...context, sources, source };
}

function sourceTransaction(source) {
  return {
    kind: 'source', id: source.id, sha256: source.sha256, size: source.size,
    sourceId: source.id, sourceSha256: source.sha256,
  };
}

test('source staged before queue reference is removed, while completed reference recovers', async (t) => {
  const first = await sourceFixture(t);
  const queueRoot = join(first.automationRoot, 'queue');
  const queue = await new DurableLocalJobQueue({ root: queueRoot, allowedJobTypes: [AUTOMATION_INSPECT_TYPE] }).initialize();
  await queue.close();
  const reopened = await new AutomationSourceStore({ root: first.automationRoot }).initialize();
  const discardReport = await reopened.recoverTransactions({ committed: [], discard: [] });
  assert.equal(discardReport.sources.removed, 1);
  await assert.rejects(reopened.openVerified(first.source.id, first.source.sha256), { code: 'AUTOMATION_SOURCE_NOT_FOUND' });

  const second = await sourceFixture(t);
  const secondQueue = await new DurableLocalJobQueue({ root: join(second.automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_INSPECT_TYPE] }).initialize();
  await secondQueue.enqueue({ type: AUTOMATION_INSPECT_TYPE, payload: { sourceId: second.source.id, sha256: second.source.sha256 }, idempotencyKey: 'source-complete', transaction: sourceTransaction(second.source) });
  const claim = await secondQueue.claim({ workerId: 'test_worker', leaseMs: 10_000 });
  await secondQueue.complete(claim.id, claim.lease.token, { ok: true });
  await secondQueue.close();
  const recovered = await new AutomationSourceStore({ root: second.automationRoot }).initialize();
  const recovery = await new DurableLocalJobQueue({ root: join(second.automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_INSPECT_TYPE] }).initialize();
  const report = await recovered.recoverTransactions(await recovery.recoveryReferences());
  assert.equal(report.sources.recovered, 1);
  assert(Object.isFrozen(report));
  const repeatReport = await recovered.recoverTransactions(await recovery.recoveryReferences());
  assert.equal(repeatReport.sources.recovered, 0);
  assert.equal(repeatReport.sources.removed, 0);
  const reopenedSource = await recovered.openVerified(second.source.id, second.source.sha256);
  assert.equal(reopenedSource.size, second.source.size);
  reopenedSource.stream.destroy();
  await recovery.close();
});

test('pending source reference survives restart and executes successfully', async (t) => {
  const context = await sourceFixture(t);
  const queueRoot = join(context.automationRoot, 'queue');
  const queue = await new DurableLocalJobQueue({ root: queueRoot, allowedJobTypes: [AUTOMATION_INSPECT_TYPE] }).initialize();
  await queue.enqueue({ type: AUTOMATION_INSPECT_TYPE, payload: { sourceId: context.source.id, sha256: context.source.sha256 }, idempotencyKey: 'pending-source', transaction: sourceTransaction(context.source) });
  await queue.close();
  const sources = await new AutomationSourceStore({ root: context.automationRoot }).initialize();
  const reopenedQueue = await new DurableLocalJobQueue({ root: queueRoot, allowedJobTypes: [AUTOMATION_INSPECT_TYPE] }).initialize();
  const recovery = await sources.recoverTransactions(await reopenedQueue.recoveryReferences());
  assert.equal(recovery.sources.removed, 0);
  const worker = new AutomationWorker({
    queue: reopenedQueue, registry: new AutomationOperationRegistry(), sources,
    store: executionStore(), service: { async inspect() { return inspection; } },
  });
  const result = await worker.runOnce();
  assert.equal(result.receipt.status, 'completed');
  await worker.close();
  await reopenedQueue.close();
});

test('output running reference is discarded and completed reference is retained after reopen', async (t) => {
  const { root, automationRoot, sources, source } = await sourceFixture(t);
  await sources.commit(source);
  const bytes = makeTextPdf('RECOVERY OUTPUT');
  const artifactPath = join(root, 'artifact.pdf');
  await writeFile(artifactPath, bytes, { mode: 0o600 });
  const artifact = { id: '44444444-4444-4444-8444-444444444444', mediaType: 'application/pdf', size: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), filePath: artifactPath, documentId: 'doc_1' };
  const store = { getArtifact: () => artifact };
  const output = await sources.stagePromotedArtifact({ store, artifactId: artifact.id, source });
  const queue = await new DurableLocalJobQueue({ root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_OCR_TYPE] }).initialize();
  await queue.enqueue({ type: AUTOMATION_OCR_TYPE, payload: { sourceId: source.id, sha256: source.sha256, language: 'eng', cleanupPreset: 'document', segmentation: 'auto', userDictionary: [] }, idempotencyKey: 'output-running' });
  const claim = await queue.claim({ workerId: 'test_worker', leaseMs: 10_000 });
  await queue.recordTransaction(claim.id, claim.lease.token, { kind: 'output', id: output.id, sha256: output.sha256, size: output.size, sourceId: output.sourceId, sourceSha256: output.sourceSha256 });
  await queue.close();
  const reopened = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const reopenedQueue = await new DurableLocalJobQueue({ root: join(automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_OCR_TYPE] }).initialize();
  const discardRefs = await reopenedQueue.recoveryReferences();
  const discarded = await reopened.recoverTransactions(discardRefs);
  assert.equal(discarded.outputs.removed, 1);
  const repeatedDiscard = await reopened.recoverTransactions(discardRefs);
  assert.equal(repeatedDiscard.outputs.removed, 0);
  assert.deepEqual(await readdir(join(automationRoot, 'outputs')), []);
  await reopenedQueue.acknowledgeDiscarded(discardRefs.discard.filter((ref) => ref.kind === 'output'));
  assert.equal((await reopenedQueue.recoveryReferences()).discard.some((ref) => ref.kind === 'output'), false);
  await assert.rejects(reopenedQueue.acknowledgeDiscarded([{ kind: 'output', id: 'missing-output', sha256: 'a'.repeat(64), size: 5, sourceId: source.id, sourceSha256: source.sha256 }]), { code: 'QUEUE_TRANSACTION_CONFLICT' });
  const retryClaim = await reopenedQueue.claim({ workerId: 'test_worker', leaseMs: 10_000 });
  const fresh = await reopened.stagePromotedArtifact({ store, artifactId: artifact.id, source });
  await reopenedQueue.recordTransaction(retryClaim.id, retryClaim.lease.token, { kind: 'output', id: fresh.id, sha256: fresh.sha256, size: fresh.size, sourceId: fresh.sourceId, sourceSha256: fresh.sourceSha256 });
  await reopenedQueue.complete(retryClaim.id, retryClaim.lease.token, { ok: true });
  await reopened.commitOutput(fresh);
  await reopenedQueue.close();

  const retained = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const second = await retained.stagePromotedArtifact({ store, artifactId: artifact.id, source });
  const completedQueue = await new DurableLocalJobQueue({ root: join(automationRoot, 'queue-2'), allowedJobTypes: [AUTOMATION_OCR_TYPE] }).initialize();
  await completedQueue.enqueue({ type: AUTOMATION_OCR_TYPE, payload: { sourceId: source.id, sha256: source.sha256, language: 'eng', cleanupPreset: 'document', segmentation: 'auto', userDictionary: [] }, idempotencyKey: 'output-complete', transaction: sourceTransaction(source) });
  const completedClaim = await completedQueue.claim({ workerId: 'test_worker', leaseMs: 10_000 });
  await completedQueue.recordTransaction(completedClaim.id, completedClaim.lease.token, { kind: 'output', id: second.id, sha256: second.sha256, size: second.size, sourceId: second.sourceId, sourceSha256: second.sourceSha256 });
  await completedQueue.complete(completedClaim.id, completedClaim.lease.token, { ok: true });
  await completedQueue.close();
  const final = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const finalQueue = await new DurableLocalJobQueue({ root: join(automationRoot, 'queue-2'), allowedJobTypes: [AUTOMATION_OCR_TYPE] }).initialize();
  const finalReport = await final.recoverTransactions(await finalQueue.recoveryReferences());
  assert.equal(finalReport.outputs.recovered, 1);
  assert.equal((await final.listOutputs()).length, 2);
  await finalQueue.close();
  await rm(artifactPath, { force: true });
});

test('recovery fails closed for corrupt marker or unexpected entries and preserves legacy records', async (t) => {
  const context = await sourceFixture(t);
  const markerPath = join(context.automationRoot, 'sources', context.source.id, 'transaction.json');
  await writeFile(markerPath, '{"broken":true}', { mode: 0o600 });
  const broken = await new AutomationSourceStore({ root: context.automationRoot }).initialize();
  await assert.rejects(broken.recoverTransactions({ committed: [], discard: [] }), { code: 'AUTOMATION_SOURCE_CORRUPT' });

  const journalBroken = await sourceFixture(t);
  await writeFile(join(journalBroken.automationRoot, 'sources', 'transactions.json'), '{"bad":true}', { mode: 0o600 });
  const brokenJournalStore = await new AutomationSourceStore({ root: journalBroken.automationRoot }).initialize();
  await assert.rejects(brokenJournalStore.recoverTransactions({ committed: [], discard: [] }), { code: 'AUTOMATION_SOURCE_CORRUPT' });

  const legacy = await sourceFixture(t);
  await legacy.sources.commit(legacy.source);
  await rm(join(legacy.automationRoot, 'sources', legacy.source.id, 'transaction.json'));
  const reopened = await new AutomationSourceStore({ root: legacy.automationRoot }).initialize();
  const report = await reopened.recoverTransactions({ committed: [], discard: [] });
  assert.equal(report.sources.legacyPreserved, 1);
  const legacySource = await reopened.openVerified(legacy.source.id, legacy.source.sha256);
  assert.equal(legacySource.size, legacy.source.size);
  legacySource.stream.destroy();

  const unsafe = await sourceFixture(t);
  await writeFile(join(unsafe.automationRoot, 'sources', unsafe.source.id, 'unexpected.bin'), Buffer.from('x'), { mode: 0o600 });
  const unsafeStore = await new AutomationSourceStore({ root: unsafe.automationRoot }).initialize();
  await assert.rejects(unsafeStore.recoverTransactions({ committed: [], discard: [] }), { code: 'AUTOMATION_SOURCE_CORRUPT' });
});

test('queue rejects duplicate or crossed transaction ownership and recovery is idempotent', async (t) => {
  const context = await sourceFixture(t);
  const transaction = sourceTransaction(context.source);
  const queue = await new DurableLocalJobQueue({ root: join(context.automationRoot, 'queue'), allowedJobTypes: [AUTOMATION_INSPECT_TYPE] }).initialize();
  await assert.rejects(queue.enqueue({ type: AUTOMATION_INSPECT_TYPE, payload: { sourceId: context.source.id, sha256: context.source.sha256 }, idempotencyKey: 'nested-ref', transaction: { source: { source: transaction, output: null }, output: null } }), { code: 'INVALID_QUEUE_TRANSACTION' });
  await assert.rejects(queue.enqueue({ type: AUTOMATION_INSPECT_TYPE, payload: { sourceId: context.source.id, sha256: context.source.sha256 }, idempotencyKey: 'swapped-ref', transaction: { source: null, output: transaction } }), { code: 'INVALID_QUEUE_TRANSACTION' });
  const request = { type: AUTOMATION_INSPECT_TYPE, payload: { sourceId: context.source.id, sha256: context.source.sha256 } };
  await queue.enqueue({ ...request, idempotencyKey: 'duplicate-one', transaction });
  await queue.enqueue({ ...request, idempotencyKey: 'duplicate-two', transaction });
  const claim = await queue.claim({ workerId: 'test_worker', leaseMs: 10_000 });
  await queue.complete(claim.id, claim.lease.token, { ok: true });
  const secondClaim = await queue.claim({ workerId: 'test_worker', leaseMs: 10_000 });
  assert(secondClaim);
  await assert.rejects(queue.recoveryReferences(), { code: 'QUEUE_TRANSACTION_CONFLICT' });
  await queue.close();

  const clean = await new AutomationSourceStore({ root: context.automationRoot }).initialize();
  await symlink(join(context.root, 'outside'), join(context.automationRoot, 'sources', 'linked'));
  await assert.rejects(clean.recoverTransactions({ committed: [], discard: [] }), { code: 'AUTOMATION_SOURCE_CORRUPT' });
});

test('discard metadata mismatch and stale missing-discard journal fail closed or reconcile', async (t) => {
  const context = await sourceFixture(t);
  const store = await new AutomationSourceStore({ root: context.automationRoot }).initialize();
  const wrong = { kind: 'source', id: context.source.id, sha256: 'a'.repeat(64), size: context.source.size + 1, sourceId: context.source.id, sourceSha256: 'a'.repeat(64) };
  await assert.rejects(store.recoverTransactions({ committed: [], discard: [wrong] }), { code: 'AUTOMATION_SOURCE_CORRUPT' });
  await rm(join(context.automationRoot, 'sources', context.source.id), { recursive: true });
  const reconciled = await new AutomationSourceStore({ root: context.automationRoot }).initialize();
  const report = await reconciled.recoverTransactions({ committed: [], discard: [wrong] }).catch((error) => error);
  assert.equal(report.code, 'AUTOMATION_SOURCE_CORRUPT');
});

test('worker preserves completed output when commitOutput throws after queue completion', async (t) => {
  const { root, automationRoot, sources, source } = await sourceFixture(t);
  await sources.commit(source);
  const bytes = makeTextPdf('COMMIT FAILURE OUTPUT');
  const artifactPath = join(root, 'commit-failure.pdf'); await writeFile(artifactPath, bytes, { mode: 0o600 });
  const execution = transientOutputIntentExecution(source, artifactPath, bytes);
  const queue = await new DurableLocalJobQueue({ root: join(automationRoot, 'queue'), allowedJobTypes: ['automation_output_intent_v1'] }).initialize();
  const registry = new AutomationOperationRegistry();
  const queued = await queue.enqueue({ ...registry.enqueueOutputIntentRequest(source), idempotencyKey: 'commit-throws' });
  let discarded = 0;
  const wrapped = {
    openVerified: (...args) => sources.openVerified(...args),
    stagePromotedArtifact: (...args) => sources.stagePromotedArtifact(...args),
    commitOutput: async () => { throw new Error('commit marker failed'); },
    discardCreatedOutput: async () => { discarded += 1; },
  };
  const worker = new AutomationWorker({ queue, registry, sources: wrapped, store: execution.store, service: {}, outputIntentService: execution.outputIntentService });
  await worker.runOnce(); await worker.close();
  assert.equal((await queue.receipt(queued.job.id)).status, 'completed'); assert.equal(discarded, 0);
  assert.equal((await readdir(join(automationRoot, 'outputs'))).length, 2);
  const refs = await queue.recoveryReferences();
  const reopened = await new AutomationSourceStore({ root: automationRoot }).initialize();
  const report = await reopened.recoverTransactions(refs);
  assert.equal(report.outputs.recovered, 1);
  assert.equal((await reopened.listOutputs()).length, 1);
  await queue.close();
});

test('worker preserves output when complete durably commits then rejects ambiguously', async (t) => {
  const { root, automationRoot, sources, source } = await sourceFixture(t); await sources.commit(source);
  const bytes = makeTextPdf('AMBIGUOUS COMPLETE OUTPUT'); const artifactPath = join(root, 'ambiguous.pdf'); await writeFile(artifactPath, bytes, { mode: 0o600 });
  const execution = transientOutputIntentExecution(source, artifactPath, bytes);
  const durableQueue = await new DurableLocalJobQueue({ root: join(automationRoot, 'queue'), allowedJobTypes: ['automation_output_intent_v1'] }).initialize();
  const registry = new AutomationOperationRegistry(); const queued = await durableQueue.enqueue({ ...registry.enqueueOutputIntentRequest(source), idempotencyKey: 'complete-ambiguous' });
  const queue = { claim: (...a) => durableQueue.claim(...a), renew: (...a) => durableQueue.renew(...a), recordTransaction: (...a) => durableQueue.recordTransaction(...a), complete: async (...a) => { await durableQueue.complete(...a); throw new Error('post-commit acknowledgement failed'); }, fail: (...a) => durableQueue.fail(...a), cancel: (...a) => durableQueue.cancel(...a), get: (...a) => durableQueue.get(...a), receipt: (...a) => durableQueue.receipt(...a) };
  let discarded = 0; const wrapped = { openVerified: (...a) => sources.openVerified(...a), stagePromotedArtifact: (...a) => sources.stagePromotedArtifact(...a), commitOutput: (...a) => sources.commitOutput(...a), discardCreatedOutput: async () => { discarded += 1; } };
  const worker = new AutomationWorker({ queue, registry, sources: wrapped, store: execution.store, service: {}, outputIntentService: execution.outputIntentService });
  await worker.runOnce(); await worker.close(); assert.equal((await durableQueue.receipt(queued.job.id)).status, 'completed'); assert.equal(discarded, 0);
  assert.equal((await readdir(join(automationRoot, 'outputs'))).length, 2);
  const refs = await durableQueue.recoveryReferences(); const reopened = await new AutomationSourceStore({ root: automationRoot }).initialize(); const report = await reopened.recoverTransactions(refs); assert.equal(report.outputs.recovered, 1); await durableQueue.close();
});
