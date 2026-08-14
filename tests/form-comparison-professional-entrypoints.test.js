import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ComparisonPackageService } from '../scripts/host/comparison-package-service.mjs';
import { ComparisonService } from '../scripts/host/comparison-service.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormTabOrderTooltipService } from '../scripts/host/pdf-acroform-tab-order-tooltip-service.mjs';
import { handleDocumentRoutes } from '../scripts/host/router-document-dispatch.mjs';
import { handleComparisonPackageRoute } from '../scripts/host/routes/comparison-package-routes.mjs';
import { handleAcroFormTabOrderTooltipRoute } from '../scripts/host/routes/acroform-tab-order-tooltip-routes.mjs';
import { createAcroFormTabOrderTooltipEndpoints } from '../src/core/local-host-acroform-tab-order-tooltip-endpoints.js';
import { createComparisonEndpoints } from '../src/core/local-host-comparison-endpoints.js';
import { makeButtonWidgetPdf } from './host-pdfkit-test-fixtures-b.js';
import { makeTextPdf } from './pdf-fixture.js';

const primaryId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const artifactId = '33333333-3333-4333-8333-333333333333';
const primarySha256 = 'a'.repeat(64);
const revisionSha256 = 'b'.repeat(64);

function response(disconnected = false) { return Object.assign(new EventEmitter(), { destroyed: disconnected, writableEnded: false }); }
function baseRoute(operation, disconnected = false) {
  const deleted = []; const writes = []; const res = response(disconnected);
  return {
    deleted, writes,
    context: {
      request: {}, response: res, url: new URL(`http://local/api/documents/${primaryId}/${operation}`), documentId: primaryId, operation,
      processing: { signal: new AbortController().signal }, store: { async deleteArtifact(id) { deleted.push(id); } },
      method() {}, json(_response, status, body) { writes.push({ status, body }); },
    },
  };
}

test('comparison-package route enforces two exact sources', async () => {
  const fixture = baseRoute('comparison-package');
  fixture.context.comparisonPackages = { async create() { throw new Error('must not run'); } };
  fixture.context.readJson = async () => ({ profile: 'local-comparison-package-v1', revisionDocumentId: primaryId, primarySha256, revisionSha256, includeVisual: false });
  await assert.rejects(handleComparisonPackageRoute(fixture.context), { code: 'INVALID_COMPARISON_PACKAGE_REQUEST' });
});

test('tab-order tooltip route binds the locator and revokes forged evidence', async () => {
  const fixture = baseRoute('acroform-tab-order-tooltip');
  const request = { profile: 'local-pdf-acroform-tab-order-tooltip-v1', sourceSha256: primarySha256, target: { page: 1, annotationIndex: 0, fingerprint: 'c'.repeat(64) }, tooltip: 'Accessible name' };
  fixture.context.readJson = async () => request;
  fixture.context.acroFormTabOrderTooltip = { async update() { return { proof: { sourceSha256: revisionSha256 }, artifact: { id: artifactId, documentId: primaryId } }; } };
  await assert.rejects(handleAcroFormTabOrderTooltipRoute(fixture.context), { code: 'ACROFORM_TAB_ORDER_TOOLTIP_RESULT_INVALID' });
  assert.deepEqual(fixture.deleted, [artifactId]);
});

test('document dispatcher admits both professional document operations', async () => {
  for (const [operation, routeName, serviceName] of [['comparison-package', 'comparisonPackage', 'comparisonPackages'], ['acroform-tab-order-tooltip', 'acroFormTabOrderTooltip', 'acroFormTabOrderTooltip']]) {
    let called = false;
    const routes = new Proxy({}, { get(_target, key) { return key === routeName ? async (context) => { called = true; assert.equal(context.operation, operation); assert.equal(context[serviceName], 'service'); return true; } : async () => false; } });
    const pathname = `/api/documents/${primaryId}/${operation}`;
    assert.equal(await handleDocumentRoutes({ pathname, request: {}, response: {}, url: new URL(`http://local${pathname}`), processing: {}, store: {}, workspaceState: {}, routes, limits: {}, [serviceName]: 'service' }), true);
    assert.equal(called, true);
  }
});

function tabRequest(bytes) {
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const fingerprint = createHash('sha256').update(Buffer.from(['pdfkit-inspector:opaque-locator:v1', `source-sha256=${sourceSha256}`, 'page=1', 'annotation-index=0', 'subtype=widget', 'widget-type=button'].join('\n'))).digest('hex');
  return { profile: 'local-pdf-acroform-tab-order-tooltip-v1', sourceSha256, target: { page: 1, annotationIndex: 0, fingerprint }, tooltip: 'Accessible name' };
}

test('strict clients accept genuine service evidence and reject malformed requests', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'professional-entrypoints-')); const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose());
  const widgetBytes = makeButtonWidgetPdf(); const widget = await store.createDocument({ stream: Readable.from([widgetBytes]), displayName: 'widget.pdf' }); const request = tabRequest(widgetBytes);
  const tabResult = await new PdfAcroFormTabOrderTooltipService({ store }).update(widget.id, request);
  const tabClient = createAcroFormTabOrderTooltipEndpoints({ json: async () => ({ result: tabResult }) });
  assert.equal((await tabClient.updateAcroFormTabOrderTooltip(widget.id, request)).proof.tabOrder, 'S');
  assert.throws(() => tabClient.updateAcroFormTabOrderTooltip(widget.id, { ...request, tooltip: '' }), /request is invalid/u);

  const primary = await store.createDocument({ stream: Readable.from([makeTextPdf('OLD')]), displayName: 'old.pdf' });
  const revision = await store.createDocument({ stream: Readable.from([makeTextPdf('NEW')]), displayName: 'new.pdf' });
  const comparison = new ComparisonService({ store, pdfService: { inspect: async () => ({ pageCount: 1 }), extractText: async (id) => [{ page: 1, text: id === primary.id ? 'old' : 'new' }], renderThumbnail: async () => { throw new Error('not requested'); } } });
  const packageResult = await new ComparisonPackageService({ store, comparison }).create(primary.id, revision.id, { primarySha256: primary.sha256, revisionSha256: revision.sha256 });
  const packageRequest = { profile: 'local-comparison-package-v1', revisionDocumentId: revision.id, primarySha256: primary.sha256, revisionSha256: revision.sha256, includeVisual: false };
  const comparisonClient = createComparisonEndpoints({ json: async () => ({ result: packageResult }) });
  assert.equal((await comparisonClient.createComparisonPackage(primary.id, packageRequest)).kind, 'comparison-package');
  assert.throws(() => comparisonClient.createComparisonPackage(primary.id, { ...packageRequest, revisionDocumentId: primary.id }), /request is invalid/u);
  const disconnected = response(true); const deleted = []; const writes = [];
  const routedStore = Object.create(store);
  routedStore.getArtifact = store.getArtifact.bind(store);
  routedStore.deleteArtifact = async (id) => { deleted.push(id); return store.deleteArtifact(id); };
  assert.equal(await handleComparisonPackageRoute({
    request: {}, response: disconnected, url: new URL(`http://local/api/documents/${primary.id}/comparison-package`), documentId: primary.id, operation: 'comparison-package',
    processing: { signal: new AbortController().signal }, store: routedStore, comparisonPackages: new ComparisonPackageService({ store, comparison }),
    method() {}, readJson: async () => packageRequest, json(_response, status, body) { writes.push({ status, body }); },
  }), true);
  assert.equal(deleted.length, 1); assert.deepEqual(writes, []); assert.throws(() => store.getArtifact(deleted[0]), { code: 'ARTIFACT_NOT_FOUND' });
  let tamperedId = null;
  const tamperingService = { async create(...args) {
    const result = await new ComparisonPackageService({ store, comparison }).create(...args); tamperedId = result.artifact.id;
    const retained = store.getArtifact(tamperedId); await writeFile(retained.filePath, Buffer.concat([await readFile(retained.filePath), Buffer.from('tamper')])); return result;
  } };
  await assert.rejects(handleComparisonPackageRoute({
    request: {}, response: response(), url: new URL(`http://local/api/documents/${primary.id}/comparison-package`), documentId: primary.id, operation: 'comparison-package',
    processing: { signal: new AbortController().signal }, store, comparisonPackages: tamperingService,
    method() {}, readJson: async () => packageRequest, json() { throw new Error('must not publish'); },
  }), { code: 'COMPARISON_PACKAGE_RESULT_INVALID', status: 502 });
  assert.throws(() => store.getArtifact(tamperedId), { code: 'ARTIFACT_NOT_FOUND' });
});
