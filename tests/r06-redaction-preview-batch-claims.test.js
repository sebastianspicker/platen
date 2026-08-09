import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import {
  FULL_PAGE_REDACTION_BATCH_PROFILE,
  validFullPageRedactionBatchRequest,
} from '../src/core/pdf-full-page-redaction-contract.js';
import { RedactionPlanReportService } from '../scripts/host/redaction-plan-report-service.mjs';
import { RedactionPlanService } from '../scripts/host/redaction-plan-service.mjs';
import { PdfFullPageRedactionService } from '../scripts/host/pdf-full-page-redaction-service.mjs';
import { handleRedactionPlanRoute } from '../scripts/host/routes/workflow-redaction-plan-routes.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';
import { makeTextPdf } from './pdf-fixture.js';

function streamObject(payload) {
  const bytes = Buffer.byteLength(payload, 'latin1');
  return `<< /Length ${bytes + 1} >>\nstream\n${payload}\nendstream`;
}

function twoPagePdf() {
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 2 /Kids [3 0 R 6 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'],
    [4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [5, streamObject('BT /F1 12 Tf 10 80 Td (secret) Tj ET')],
    [6, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources << /Font << /F1 8 0 R >> >> /Contents 7 0 R >>'],
    [7, streamObject('BT /F1 12 Tf 10 80 Td (survivor) Tj ET')],
    [8, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ]);
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  for (const [number, body] of bodies) { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 9\n0000000000 65535 f \n');
  for (let index = 1; index < 9; index += 1) chunks.push(`${String(offsets.get(index)).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function png(black) {
  const pixels = Buffer.alloc(16);
  for (let index = 0; index < 4; index += 1) {
    pixels[index * 4] = black ? 0 : 255;
    pixels[index * 4 + 1] = black ? 0 : 255;
    pixels[index * 4 + 2] = black ? 0 : 255;
    pixels[index * 4 + 3] = 255;
  }
  return encodeRgbaPng({ width: 2, height: 2, pixels });
}

async function planFixture(context) {
  const store = await new DocumentStore({ root: await mkdtemp(join(tmpdir(), 'r06-redaction-plan-')) }).initialize();
  context.after(() => store.dispose());
  const workspace = new WorkspaceStateStore(store);
  const poppler = { async execute(operation) {
    if (operation === 'inspect') return { stdout: 'Pages: 1\n' };
    if (operation === 'inspectPage') return { stdout: 'Page 1 size: 612 x 792 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 612 792\nPage 1 CropBox: 0 0 612 792\n' };
    if (operation === 'extractTextRegion') return { stdout: 'TOP SECRET\n' };
    assert.fail(`unexpected Poppler operation ${operation}`);
  } };
  const plans = new RedactionPlanService({
    documentStore: store, workspaceStateStore: workspace, poppler, rasterMutations: {},
    bindingKey: Buffer.alloc(32, 7), clock: () => '2026-07-19T00:00:00.000Z',
    idFactory: (prefix) => `${prefix}-r06`,
  });
  return { store, workspace, plans, reports: new RedactionPlanReportService({ documentStore: store, workspaceStateStore: workspace }) };
}

async function batchFixture(context, { cancelled = false, cleanupFailure = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'r06-full-page-batch-')); context.after(() => rm(root, { recursive: true, force: true }));
  const sourceBytes = twoPagePdf(); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const documentId = '11111111-1111-4111-8111-111111111111'; const controller = new AbortController();
  const observed = { deleted: [], promoted: 0, workspaces: [] };
  const store = {
    getDocument: () => ({ id: documentId, sha256: sourceSha256, size: sourceBytes.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => createHash('sha256').update(await readFile(sourcePath)).digest('hex') === sourceSha256,
    createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); observed.workspaces.push(path); return path; },
    cleanupJob: async (path) => { await rm(path, { recursive: true, force: true }); if (cleanupFailure) throw new Error('cleanup failed'); },
    promotePdfArtifact: async (_id, _path, promotion) => {
      observed.promoted += 1; if (cancelled) controller.abort(new Error('cancelled'));
      return { id: '22222222-2222-4222-8222-222222222222', documentId, displayName: 'source-full-page-redaction-batch.pdf', mediaType: 'application/pdf', size: sourceBytes.length, sha256: promotion.expectedSha256, operation: promotion.operation, createdAt: '2026-07-19T00:00:00.000Z' };
    },
    deleteArtifact: async (id) => { observed.deleted.push(id); },
  };
  const poppler = { execute: async (operation, parameters) => {
    const output = String(parameters.input).endsWith('/output.pdf');
    if (operation === 'inspect') return { stdout: 'Pages: 2\nEncrypted: no\nForm: none\nJavaScript: no\n' };
    if (operation === 'inspectMetadata' || operation === 'inspectCustomMetadata') return { stdout: '' };
    if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures`, stderr: '', exitCode: 0 };
    if (operation === 'inspectPageBoxes') return { stdout: 'Page 1 size: 100 x 100 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 100 100\nPage 1 CropBox: 0 0 100 100\nPage 2 size: 100 x 100 pts\nPage 2 rot: 0\nPage 2 MediaBox: 0 0 100 100\nPage 2 CropBox: 0 0 100 100\n' };
    if (operation === 'listAttachments' || operation === 'inspectUrls') return { stdout: '' };
    if (operation === 'extractText') return { stdout: output ? '\f' : 'secret\fsurvivor', stderr: '' };
    if (operation === 'renderPagePng') { await writeFile(`${parameters.outputPrefix}.png`, png(output)); return { stdout: '' }; }
    throw new Error(`unexpected Poppler operation ${operation}`);
  } };
  return { service: new PdfFullPageRedactionService({ store, poppler }), store, sourceBytes, sourcePath, sourceSha256, documentId, controller, observed };
}

test('redaction preview is a source/workspace-bound proposed geometry-only report', async (context) => {
  const { store, workspace, plans, reports } = await planFixture(context);
  const sourceBytes = makeTextPdf('TOP SECRET');
  const source = await store.createDocument({ stream: Readable.from([sourceBytes]), displayName: 'secret.pdf' });
  const created = await plans.createPlan(source.id, { schemaVersion: 1, profile: 'source-bound-redaction-plan-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: 0, targets: [{ page: 1, region: { x: 0, y: 0, width: 1, height: 1 } }] });
  const request = { schemaVersion: 1, profile: 'source-bound-redaction-plan-report-v1', sourceSha256: source.sha256, expectedWorkspaceRevision: created.revision, planId: created.plan.id, planSha256: created.plan.planSha256 };
  const report = await reports.report(source.id, request);
  assert.equal(report.reportStatus, 'proposed-not-applied');
  assert.equal(report.sourceSha256, source.sha256);
  assert.equal(report.workspaceRevision, created.revision);
  assert.equal(report.pdfBytesChanged, false);
  assert.deepEqual(Object.keys(report.marks[0]).sort(), ['id', 'page', 'region']);
  assert.doesNotMatch(JSON.stringify(report), /TOP SECRET/u);
  assert.deepEqual(await readFile(store.getSourcePath(source.id)), sourceBytes);
  assert.equal(workspace.snapshot(source.id).revision, created.revision);
  const response = {};
  await handleRedactionPlanRoute({
    request: { method: 'POST' }, response,
    url: new URL(`http://local/api/documents/${source.id}/redaction-report`), documentId: source.id,
    operation: 'redaction-report', processing: { signal: new AbortController().signal },
    redactionPlans: plans, redactionPlanReports: reports,
    method: (value, expected) => assert.equal(value.method, expected), readJson: async () => request,
    json: (_response, status, value) => { response.status = status; response.value = value; },
  });
  assert.equal(response.status, 200);
  assert.equal(response.value.reportStatus, 'proposed-not-applied');
  await assert.rejects(reports.report(source.id, { ...request, expectedWorkspaceRevision: 0 }), { code: 'REVISION_CONFLICT' });
});

test('redaction preview client rejects a forged non-proposed result', async () => {
  const report = { schemaVersion: 1, profile: 'source-bound-redaction-plan-report-v1', sourceSha256: 'a'.repeat(64), workspaceRevision: 1, planId: 'redaction-plan-r06', planSha256: 'b'.repeat(64), coordinateSpace: 'normalized-cropbox-top-left-v1', applicationProfile: 'verified-raster-burn-v2', marks: [], reportStatus: 'proposed-not-applied', pdfBytesChanged: true, reportSha256: 'c'.repeat(64) };
  const client = new LocalHostClient({ fetchImpl: async (path) => path === '/api/bootstrap'
    ? new Response(JSON.stringify({ sessionToken: 'd'.repeat(64) }), { status: 200 })
    : new Response(JSON.stringify(report), { status: 200 }) });
  await client.bootstrap();
  await assert.rejects(client.exportRedactionPlanReport('doc', { sourceSha256: report.sourceSha256, expectedWorkspaceRevision: 1, planId: report.planId, planSha256: report.planSha256 }), TypeError);
});

test('full-page batch accepts the fixed 1-32 ascending contract and produces one separate source-bound artifact', async (context) => {
  assert.equal(validFullPageRedactionBatchRequest({ pages: [1] }), true);
  assert.equal(validFullPageRedactionBatchRequest({ pages: [1, 2, ...Array.from({ length: 30 }, (_, index) => index + 3)] }), true);
  assert.equal(validFullPageRedactionBatchRequest({ pages: [1, 1] }), false);
  assert.equal(validFullPageRedactionBatchRequest({ pages: [2, 1] }), false);
  const fixture = await batchFixture(context);
  const before = await readFile(fixture.sourcePath);
  const result = await fixture.service.updateBatch(fixture.documentId, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: fixture.sourceSha256, pages: [1, 2] }, { sourceSha256: fixture.sourceSha256 });
  assert.equal(result.kind, 'pdf-full-page-redaction-batch');
  assert.deepEqual(result.pages, [1, 2]);
  assert.equal(result.evidence.sourceUnchanged, true);
  assert.equal(result.artifact.id === fixture.documentId, false);
  assert.equal(result.artifact.operation.validation.passed, true);
  assert.deepEqual(await readFile(fixture.sourcePath), before);
  assert.equal(await fixture.store.verifySource(fixture.documentId), true);
  assert.equal(fixture.observed.promoted, 1);
});

test('full-page batch cancellation revokes the promoted artifact and cleans private workspaces', async (context) => {
  const fixture = await batchFixture(context, { cancelled: true });
  await assert.rejects(fixture.service.updateBatch(fixture.documentId, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256: fixture.sourceSha256, pages: [1, 2] }, { sourceSha256: fixture.sourceSha256, signal: fixture.controller.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(fixture.observed.deleted, ['22222222-2222-4222-8222-222222222222']);
  for (const path of fixture.observed.workspaces) await assert.rejects(access(path), { code: 'ENOENT' });
});
