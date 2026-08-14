import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { RedactionPlanService } from '../scripts/host/redaction-plan-service.mjs';
import { RedactionPlanReportService } from '../scripts/host/redaction-plan-report-service.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { makeTextPdf } from './pdf-fixture.js';

function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
function digest(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

async function fixture(context) {
  const store = await new DocumentStore({ root: await mkdtemp(join(tmpdir(), 'redaction-plan-report-')) }).initialize();
  context.after(() => store.dispose());
  const workspace = new WorkspaceStateStore(store);
  const poppler = { async execute(operation) {
    if (operation === 'inspect') return { stdout: 'Pages: 1\n' };
    if (operation === 'inspectPage') return { stdout: 'Page 1 size: 612 x 792 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 612 792\nPage 1 CropBox: 0 0 612 792\n' };
    if (operation === 'extractTextRegion') return { stdout: 'TOP SECRET\n' };
    assert.fail(`Unexpected Poppler operation ${operation}`);
  } };
  const plans = new RedactionPlanService({ documentStore: store, workspaceStateStore: workspace, poppler, rasterMutations: { async redact() { assert.fail('Report export must not apply a plan.'); } }, bindingKey: Buffer.alloc(32, 7), idFactory: (prefix) => `${prefix}-id`, clock: () => '2026-07-19T00:00:00.000Z' });
  const reports = new RedactionPlanReportService({ documentStore: store, workspaceStateStore: workspace });
  const source = await store.createDocument({ stream: Readable.from([makeTextPdf('TOP SECRET')]), displayName: 'secret.pdf' });
  const created = await plans.createPlan(source.id, { schemaVersion: 1, profile: 'source-bound-redaction-plan-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: 0, targets: [{ page: 1, region: { x: 0, y: 0, width: 1, height: 1 } }] });
  const request = () => ({ schemaVersion: 1, profile: 'source-bound-redaction-plan-report-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: workspace.snapshot(source.id).revision, planId: created.plan.id, planSha256: created.plan.planSha256 });
  return { store, workspace, reports, source, created, request };
}

test('redaction plan report is canonical, bounded, private, and read-only', async (context) => {
  const { workspace, reports, source, created, request } = await fixture(context);
  const before = workspace.snapshot(source.id);
  const report = await reports.report(source.id, request());
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'profile', 'sourceSha256', 'workspaceRevision', 'planId', 'planSha256', 'planCreatedAtLocal', 'coordinateSpace', 'applicationProfile', 'marks', 'reportStatus', 'pdfBytesChanged', 'reportSha256']);
  assert.deepEqual(Object.keys(report.marks[0]), ['id', 'page', 'region']);
  assert.deepEqual(Object.keys(report.marks[0].region), ['x', 'y', 'width', 'height']);
  assert.equal(report.profile, 'source-bound-redaction-plan-report-v1');
  assert.equal(report.sourceSha256, source.sha256); assert.equal(report.workspaceRevision, created.revision);
  assert.equal(report.reportStatus, 'proposed-not-applied'); assert.equal(report.pdfBytesChanged, false);
  const { reportSha256, ...unsigned } = report; assert.equal(reportSha256, digest(unsigned));
  assert.equal(report.marks.length, 1); assert.equal(Object.isFrozen(report), true);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /TOP SECRET|textBinding|pageGeometrySha256|hmacSha256|length|source-bound\.pdf|artifact/i);
  assert.deepEqual(workspace.snapshot(source.id), before);
});

test('redaction plan report rejects stale source or workspace revision without mutation', async (context) => {
  const { store, workspace, reports, source, request } = await fixture(context);
  await assert.rejects(reports.report(source.id, { ...request(), expectedWorkspaceRevision: 0 }), { code: 'REVISION_CONFLICT', status: 409 });
  const before = workspace.snapshot(source.id);
  await writeFile(store.getSourcePath(source.id), makeTextPdf('CHANGED SOURCE'));
  await assert.rejects(reports.report(source.id, request()), { code: 'SOURCE_INTEGRITY_FAILED', status: 500 });
  assert.deepEqual(workspace.snapshot(source.id), before);
});

test('redaction plan report rejects missing, tampered, and legacy plans', async (context) => {
  const { workspace, reports, source, request } = await fixture(context);
  await assert.rejects(reports.report(source.id, { ...request(), planId: 'missing-plan' }), { code: 'LEGACY_REDACTION_PLAN_REJECTED', status: 409 });
  let snapshot = structuredClone(workspace.snapshot(source.id)); snapshot.namespaces.redactions[0].planSha256 = '0'.repeat(64);
  workspace.replaceSnapshot(source.id, snapshot, { expectedRevision: snapshot.revision });
  await assert.rejects(reports.report(source.id, { ...request(), expectedWorkspaceRevision: workspace.snapshot(source.id).revision }), { code: 'PLAN_TAMPERED', status: 409 });
  snapshot = structuredClone(workspace.snapshot(source.id)); snapshot.namespaces.redactions[0] = { id: 'legacy', type: 'redaction-plan', status: 'proposed-not-applied', marks: [] };
  workspace.replaceSnapshot(source.id, snapshot, { expectedRevision: snapshot.revision });
  await assert.rejects(reports.report(source.id, { ...request(), expectedWorkspaceRevision: workspace.snapshot(source.id).revision, planId: 'legacy' }), { code: 'LEGACY_REDACTION_PLAN_REJECTED', status: 409 });
});

test('redaction plan report rejects a noncanonical timestamp even with a recomputed plan digest', async (context) => {
  const { workspace, reports, source, request } = await fixture(context);
  const snapshot = structuredClone(workspace.snapshot(source.id)); const record = snapshot.namespaces.redactions[0];
  record.createdAtLocal = 'July 19, 2026';
  record.planSha256 = digest(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'planSha256')));
  workspace.replaceSnapshot(source.id, snapshot, { expectedRevision: snapshot.revision });
  await assert.rejects(reports.report(source.id, {
    ...request(), expectedWorkspaceRevision: workspace.snapshot(source.id).revision,
    planSha256: record.planSha256,
  }), { code: 'LEGACY_REDACTION_PLAN_REJECTED', status: 409 });
});

test('redaction plan report rejects plans outside the 64-mark boundary', async (context) => {
  const { workspace, reports, source, request } = await fixture(context);
  const snapshot = structuredClone(workspace.snapshot(source.id)); const record = snapshot.namespaces.redactions[0];
  const first = record.marks[0];
  record.marks = Array.from({ length: 65 }, (_, index) => ({ ...first, id: `mark-${index + 1}` }));
  record.planSha256 = digest(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'planSha256')));
  workspace.replaceSnapshot(source.id, snapshot, { expectedRevision: snapshot.revision });
  await assert.rejects(reports.report(source.id, { ...request(), expectedWorkspaceRevision: workspace.snapshot(source.id).revision, planSha256: record.planSha256 }), { code: 'LEGACY_REDACTION_PLAN_REJECTED', status: 409 });
});

test('redaction plan report rejects overlapping valid-looking marks', async (context) => {
  const { workspace, reports, source, request } = await fixture(context);
  const snapshot = structuredClone(workspace.snapshot(source.id)); const record = snapshot.namespaces.redactions[0];
  record.marks.push({ ...record.marks[0], id: 'overlapping-mark' });
  record.planSha256 = digest(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'planSha256')));
  workspace.replaceSnapshot(source.id, snapshot, { expectedRevision: snapshot.revision });
  await assert.rejects(reports.report(source.id, { ...request(), expectedWorkspaceRevision: workspace.snapshot(source.id).revision, planSha256: record.planSha256 }), { code: 'LEGACY_REDACTION_PLAN_REJECTED', status: 409 });
});

test('redaction plan report rejects cancellation and does not mutate the workspace', async (context) => {
  const { workspace, reports, source, request } = await fixture(context);
  const before = workspace.snapshot(source.id); const controller = new AbortController(); controller.abort();
  await assert.rejects(reports.report(source.id, request(), { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.deepEqual(workspace.snapshot(source.id), before);
});

test('redaction plan report holds its read lease and cancels during source verification', async (context) => {
  const { store, workspace, source, request } = await fixture(context);
  let releaseVerification;
  let verificationStarted;
  const started = new Promise((resolve) => { verificationStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseVerification = resolve; });
  let calls = 0;
  const documents = {
    getDocument: (id) => store.getDocument(id),
    async verifySource(id) {
      await store.verifySource(id);
      calls += 1;
      if (calls === 1) { verificationStarted(); await blocked; }
    },
  };
  const reports = new RedactionPlanReportService({
    documentStore: documents, workspaceStateStore: workspace,
  });
  const controller = new AbortController();
  const reportRequest = request();
  const pending = reports.report(source.id, reportRequest, { signal: controller.signal });
  await started;
  assert.throws(() => workspace.appendAuditEvent(source.id, { kind: 'race' }, {
    expectedRevision: reportRequest.expectedWorkspaceRevision,
  }), { code: 'WORKSPACE_READ_LEASED', status: 409 });
  controller.abort(new Error('cancel during verification'));
  releaseVerification();
  await assert.rejects(pending, { code: 'JOB_CANCELLED', status: 499 });
  assert.equal(workspace.appendAuditEvent(source.id, { kind: 'after-cancel' }, {
    expectedRevision: reportRequest.expectedWorkspaceRevision,
  }).revision, reportRequest.expectedWorkspaceRevision + 1);
});
