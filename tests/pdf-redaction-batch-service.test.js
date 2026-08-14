import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { HostError } from '../scripts/host/host-error.mjs';
import {
  PdfRedactionBatchService,
  REDACTION_BATCH_PROFILE,
} from '../scripts/host/pdf-redaction-batch-service.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const sourceA = digest('source-a');
const sourceB = digest('source-b');
const planDigest = digest('plan');
const mark = (id) => `mark-${id}`;
const DOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function plan(sourceSha256, id) {
  return {
    schemaVersion: 1, profile: 'source-bound-redaction-application-v1', sourceSha256,
    expectedWorkspaceRevision: 0, planId: `plan-${id}`, planSha256: planDigest,
    markIds: [mark(id)],
  };
}

function request(entries = [
  { documentId: DOC_B, sourceSha256: sourceB, plan: plan(sourceB, 'b') },
  { documentId: DOC_A, sourceSha256: sourceA, plan: plan(sourceA, 'a') },
]) { return { profile: REDACTION_BATCH_PROFILE, documents: entries }; }

function fixture({ failAt = null, sameOutput = false, overwrite = false, existingArtifact = null } = {}) {
  const artifacts = new Map();
  const docs = new Map([
    [DOC_A, { id: DOC_A, sha256: sourceA, displayName: 'a.pdf' }],
    [DOC_B, { id: DOC_B, sha256: sourceB, displayName: 'b.pdf' }],
  ]);
  const deleted = [];
  const store = {
    artifacts, deleted,
    getDocument(id) { const value = docs.get(id); if (!value) throw new HostError('DOCUMENT_NOT_FOUND', 'missing', 404); return value; },
    async verifySource(id) { if (overwrite && id === DOC_A) docs.get(id).sha256 = digest('changed'); return true; },
    async deleteArtifact(id) { deleted.push(id); artifacts.delete(id); },
    ...(existingArtifact ? { listArtifactIds: async () => [existingArtifact] } : {}),
  };
  let calls = [];
  const redactionPlans = {
    async applyPlan(documentId) {
      calls.push(documentId);
      if (failAt === documentId) throw new HostError('ENGINE_FAILED', 'failed', 502);
      const id = sameOutput ? 'artifact-same' : `artifact-${documentId}`;
      const selectedPlan = documentId === DOC_A ? plan(sourceA, 'a') : plan(sourceB, 'b');
      const artifact = { id, documentId, displayName: `${documentId}.pdf`, mediaType: 'application/pdf', size: 100, sha256: digest(id), operation: { schemaVersion: 1, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', type: 'raster-redact', inputs: [{ documentId, sha256: documentId === DOC_A ? sourceA : sourceB, role: 'source' }], parameters: { planBinding: { planId: selectedPlan.planId, planSha256: selectedPlan.planSha256, workspaceRevision: selectedPlan.expectedWorkspaceRevision, markIds: selectedPlan.markIds } }, expected: {}, validation: { passed: true, validators: ['test'] }, completedAt: '2026-07-21T00:00:00.000Z' }, createdAt: '2026-07-21T00:00:00.000Z' };
      artifacts.set(id, artifact);
      return { artifact };
    },
  };
  return { store, redactionPlans, calls, service: new PdfRedactionBatchService({ store, redactionPlans }) };
}

test('batch preflights immutable plans and returns canonical document order', async () => {
  const fixtureValue = fixture();
  const result = await fixtureValue.service.apply(request());
  assert.equal(result.status, 'committed');
  assert.deepEqual(result.documents.map(({ documentId }) => documentId), [DOC_A, DOC_B]);
  assert.deepEqual(fixtureValue.calls, [DOC_A, DOC_B]);
});

test('batch rejects accessors, proxies, duplicate documents, and mismatched plans before execution', async () => {
  const fixtureValue = fixture();
  const accessor = request(); Object.defineProperty(accessor.documents[0], 'documentId', { get() { throw new Error('getter'); } });
  await assert.rejects(fixtureValue.service.apply(accessor), { code: 'INVALID_REDACTION_BATCH' });
  const proxy = new Proxy(request(), { ownKeys() { throw new Error('trap'); } });
  await assert.rejects(fixtureValue.service.apply(proxy), { code: 'INVALID_REDACTION_BATCH' });
  const duplicate = request([request().documents[0], request().documents[0]]);
  await assert.rejects(fixtureValue.service.apply(duplicate), { code: 'REDACTION_BATCH_DUPLICATE_DOCUMENT' });
  const mismatch = request(); mismatch.documents[0].plan.sourceSha256 = sourceA;
  await assert.rejects(fixtureValue.service.apply(mismatch), { code: 'REDACTION_BATCH_SOURCE_MISMATCH' });
  assert.deepEqual(fixtureValue.calls, []);
});

test('mid-batch failure revokes every previously promoted output and never reports partial success', async () => {
  const fixtureValue = fixture({ failAt: DOC_B });
  await assert.rejects(fixtureValue.service.apply(request()), { code: 'ENGINE_FAILED' });
  assert.deepEqual(fixtureValue.store.deleted, [`artifact-${DOC_A}`]);
  assert.equal(fixtureValue.store.artifacts.size, 0);
});

test('cancellation at a boundary revokes prior output', async () => {
  const fixtureValue = fixture();
  const controller = new AbortController();
  const original = fixtureValue.redactionPlans.applyPlan;
  fixtureValue.redactionPlans.applyPlan = async (...args) => { const result = await original(...args); controller.abort(); return result; };
  await assert.rejects(fixtureValue.service.apply(request(), { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.deepEqual(fixtureValue.store.deleted, [`artifact-${DOC_A}`]);
});

test('output collisions and source mutation fail closed without overwriting sources', async () => {
  const collision = fixture({ sameOutput: true });
  await assert.rejects(collision.service.apply(request()), { code: 'REDACTION_BATCH_OUTPUT_COLLISION' });
  assert.deepEqual(collision.store.deleted, ['artifact-same']);
  const mutated = fixture({ overwrite: true });
  await assert.rejects(mutated.service.apply(request()), { code: 'SOURCE_VERSION_MISMATCH' });
  assert.deepEqual(mutated.store.deleted, []);
});

test('pre-existing artifact IDs are stale collisions and are never revoked', async () => {
  const fixtureValue = fixture({ existingArtifact: 'artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  fixtureValue.redactionPlans.applyPlan = async (documentId) => ({ artifact: {
    id: 'artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', documentId, displayName: 'stale.pdf', mediaType: 'application/pdf', size: 100,
    sha256: digest('stale'), operation: {}, createdAt: '2026-07-21T00:00:00.000Z',
  } });
  await assert.rejects(fixtureValue.service.apply(request()), { code: 'REDACTION_BATCH_STALE_ARTIFACT' });
  assert.deepEqual(fixtureValue.store.deleted, []);
});

test('successful commit resolution is terminal even when cancellation occurs before resolution', async () => {
  const fixtureValue = fixture();
  const controller = new AbortController();
  const service = new PdfRedactionBatchService({
    store: fixtureValue.store,
    redactionPlans: fixtureValue.redactionPlans,
    commitBatch: async () => {
      controller.abort();
      await Promise.resolve();
    },
  });
  const result = await service.apply(request(), { signal: controller.signal });
  assert.equal(result.status, 'committed');
  assert.deepEqual(fixtureValue.store.deleted, []);
  assert.equal(fixtureValue.store.artifacts.size, 2);
  assert.deepEqual(result.commit, { status: 'committed' });
});

test('commit metadata is not retained or recursively frozen', async () => {
  const fixtureValue = fixture();
  const metadata = { mutable: { value: true } };
  const service = new PdfRedactionBatchService({
    store: fixtureValue.store,
    redactionPlans: fixtureValue.redactionPlans,
    commitBatch: async () => metadata,
  });
  const result = await service.apply(request());
  metadata.mutable.value = false;
  assert.deepEqual(result.commit, { status: 'committed' });
  assert.equal(Object.isFrozen(metadata), false);
  assert.equal(Object.isFrozen(metadata.mutable), false);
});
