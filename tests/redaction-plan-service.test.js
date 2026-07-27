import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { RedactionPlanService } from '../scripts/host/redaction-plan-service.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { makeTextPdf } from './pdf-fixture.js';

async function fixture(context, { idFactory, onRedact } = {}) {
  const store = await new DocumentStore({ root: await mkdtemp(join(tmpdir(), 'redaction-plan-')) }).initialize(); context.after(() => store.dispose());
  const workspace = new WorkspaceStateStore(store); let parameters = null;
  const poppler = { async execute(operation) {
    if (operation === 'inspect') return { stdout: 'Pages: 1\n' };
    if (operation === 'inspectPage') return { stdout: 'Page 1 size: 612 x 792 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 612 792\nPage 1 CropBox: 0 0 612 792\n' };
    if (operation === 'extractTextRegion') return { stdout: 'TOP SECRET\n' };
    assert.fail(`Unexpected Poppler operation ${operation}`);
  } };
  const rasterMutations = { async redact(documentId, request) { parameters = request; await onRedact?.(documentId, request, store); return { id: 'artifact-1', documentId, operation: { parameters: request } }; } };
  const service = new RedactionPlanService({ documentStore: store, workspaceStateStore: workspace, poppler, rasterMutations, bindingKey: Buffer.alloc(32, 7), idFactory: idFactory ?? ((prefix) => `${prefix}-id`), clock: () => '2026-07-19T00:00:00.000Z' });
  return { store, workspace, service, getParameters: () => parameters };
}

test('source-bound plans retain no text and application derives trusted transient text only', async (context) => {
  const { store, workspace, service, getParameters } = await fixture(context);
  const source = await store.createDocument({ stream: Readable.from([makeTextPdf('TOP SECRET')]), displayName: 'secret.pdf' });
  const created = await service.createPlan(source.id, { schemaVersion: 1, profile: 'source-bound-redaction-plan-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: 0, targets: [{ page: 1, region: { x: 0, y: 0, width: 1, height: 1 } }] });
  assert.doesNotMatch(JSON.stringify(created.plan), /TOP SECRET/); assert.equal(created.plan.status, 'proposed-not-applied');
  const stored = workspace.snapshot(source.id).namespaces.redactions[0]; assert.doesNotMatch(JSON.stringify(stored), /TOP SECRET/);
  const applied = await service.applyPlan(source.id, { schemaVersion: 1, profile: 'source-bound-redaction-application-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: created.revision, planId: created.plan.id, planSha256: created.plan.planSha256, markIds: [created.plan.marks[0].id] });
  assert.equal(applied.application.textEvidence, 'validated-transiently-not-retained'); assert.equal(getParameters().redactions[0].removedText, 'TOP SECRET');
  assert.deepEqual(getParameters().planBinding.markIds, [created.plan.marks[0].id]); assert.equal(workspace.snapshot(source.id).revision, created.revision);
});

test('application rejects legacy, altered, and client-supplied geometry contracts', async (context) => {
  const { store, workspace, service } = await fixture(context);
  const source = await store.createDocument({ stream: Readable.from([makeTextPdf('TOP SECRET')]), displayName: 'secret.pdf' });
  const created = await service.createPlan(source.id, { schemaVersion: 1, profile: 'source-bound-redaction-plan-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: 0, targets: [{ page: 1, fullPage: true }] });
  await assert.rejects(service.applyPlan(source.id, { schemaVersion: 1, profile: 'source-bound-redaction-application-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: created.revision, planId: created.plan.id, planSha256: created.plan.planSha256, markIds: [created.plan.marks[0].id], targets: [] }), { code: 'INVALID_REDACTION_APPLICATION' });
  const tampered = JSON.parse(JSON.stringify(workspace.snapshot(source.id))); tampered.namespaces.redactions[0].planSha256 = '0'.repeat(64); workspace.replaceSnapshot(source.id, tampered, { expectedRevision: created.revision });
  await assert.rejects(service.applyPlan(source.id, { schemaVersion: 1, profile: 'source-bound-redaction-application-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: created.revision + 1, planId: created.plan.id, planSha256: created.plan.planSha256, markIds: [created.plan.marks[0].id] }), { code: 'PLAN_TAMPERED' });
});

test('plan creation rejects duplicate, full-page-overlap, and invalid generated identifiers', async (context) => {
  const { store, service } = await fixture(context);
  const source = await store.createDocument({ stream: Readable.from([makeTextPdf('TOP SECRET')]), displayName: 'secret.pdf' });
  const base = { schemaVersion: 1, profile: 'source-bound-redaction-plan-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: 0 };
  await assert.rejects(service.createPlan(source.id, { ...base, targets: [{ page: 1, fullPage: true }, { page: 1, region: { x: 0, y: 0, width: 1, height: 1 } }] }), { code: 'INVALID_REDACTION_PLAN' });
  await assert.rejects(service.createPlan(source.id, { ...base, targets: [{ page: 1, fullPage: true }, { page: 1, fullPage: true }] }), { code: 'INVALID_REDACTION_PLAN' });
  const invalidFixture = await fixture(context, { idFactory: () => '../bad' });
  const invalidSource = await invalidFixture.store.createDocument({ stream: Readable.from([makeTextPdf('TOP SECRET')]), displayName: 'bad-id.pdf' });
  await assert.rejects(invalidFixture.service.createPlan(invalidSource.id, { ...base, sourceSha256: invalidSource.sha256, targets: [{ page: 1, fullPage: true }] }), { code: 'INVALID_PLAN_ID' });
});

test('failed post-artifact rollback reports a sanitized typed failure', async (context) => {
  const { store, service } = await fixture(context, { onRedact: async (documentId, _request, documents) => {
    await writeFile(documents.getSourcePath(documentId), makeTextPdf('CHANGED SOURCE'));
  } });
  store.deleteArtifact = async () => { throw new Error('disk failure'); };
  const source = await store.createDocument({ stream: Readable.from([makeTextPdf('TOP SECRET')]), displayName: 'secret.pdf' });
  const created = await service.createPlan(source.id, { schemaVersion: 1, profile: 'source-bound-redaction-plan-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: 0, targets: [{ page: 1, fullPage: true }] });
  await assert.rejects(service.applyPlan(source.id, { schemaVersion: 1, profile: 'source-bound-redaction-application-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: created.revision, planId: created.plan.id, planSha256: created.plan.planSha256, markIds: [created.plan.marks[0].id] }), { code: 'REDACTION_ARTIFACT_ROLLBACK_FAILED', status: 500 });
});
