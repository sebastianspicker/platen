import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { comparePixels } from '../scripts/host/comparison-algorithms.mjs';
import * as comparisonFacade from '../scripts/host/comparison-service.mjs';
import { decodePng, encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PdfService } from '../scripts/host/pdf-service.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import { makeTextPdf } from './pdf-fixture.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const { ComparisonService } = comparisonFacade;
function png(rgba) { return encodeRgbaPng({ width: 1, height: 1, pixels: Buffer.from(rgba) }); }
function fakeStore() { const docs = new Map([[first, { id: first, sha256: 'a'.repeat(64) }], [second, { id: second, sha256: 'b'.repeat(64) }]]); return { getDocument: (id) => { if (!docs.has(id)) throw Object.assign(new Error('missing'), { code: 'DOCUMENT_NOT_FOUND' }); return docs.get(id); }, verifySource: async () => true }; }

test('comparison facade exposes only its coordinator class', () => {
  assert.deepEqual(Object.keys(comparisonFacade), ['ComparisonService']);
});

test('content comparison is page-aware, preserves source checks, and exports JSON and CSV', async () => {
  const service = new ComparisonService({ store: fakeStore(), pdfService: { inspect: async (id) => ({ pageCount: id === first ? 1 : 2 }), extractText: async (id) => id === first ? [{ page: 1, text: 'alpha old' }] : [{ page: 1, text: 'alpha new' }, { page: 2, text: 'added page' }], renderThumbnail: async () => png([0, 0, 0, 255]) } });
  const report = await service.compareContent(first, second);
  assert.deepEqual(report.stats, { added: 3, deleted: 1, unchanged: 1, changed: 4, leftPages: 1, rightPages: 2 });
  assert.equal(report.pages[1].rightPresent, true);
  const json = service.exportContentReport(report, { format: 'json' }).data;
  assert.match(json, /"content"/);
  assert.doesNotMatch(json, /documentId/u);
  assert.deepEqual(JSON.parse(json).inputs, [
    { role: 'primary', sha256: 'a'.repeat(64) },
    { role: 'secondary', sha256: 'b'.repeat(64) },
  ]);
  const csv = service.exportContentReport(report, { format: 'csv' }).data;
  assert.match(csv, /"primarySha256","secondarySha256"/u);
  assert.match(csv, new RegExp(`"${'a'.repeat(64)}","${'b'.repeat(64)}"`, 'u'));
  assert.match(csv, /"unchanged"/u);
  assert.throws(
    () => service.exportContentReport(structuredClone(report), { format: 'json' }),
    { code: 'INVALID_REPORT', status: 502 },
  );
});

test('pixel comparison measures decoded pixels, produces a verified PNG difference, and bounds batch work', async () => {
  const metric = comparePixels(png([0, 0, 0, 255]), png([12, 0, 0, 255]));
  assert.equal(metric.changedPixels, 1); assert.equal(metric.maximumChannelDelta, 12); assert.deepEqual(decodePng(metric.differencePng).pixels, Buffer.from([255, 0, 0, 255]));
  const service = new ComparisonService({ store: fakeStore(), limits: { maxPairs: 1 }, pdfService: { inspect: async () => ({ pageCount: 1 }), extractText: async () => [], renderThumbnail: async (id) => png(id === first ? [0, 0, 0, 255] : [1, 0, 0, 255]) } });
  const report = await service.comparePixels(first, second); assert.equal(report.stats.changedPixels, 1); assert.equal(report.pages[0].differenceImage.format, 'image/png'); assert.doesNotThrow(() => JSON.stringify(report));
  await assert.rejects(service.compareBatch([{ primaryDocumentId: first, secondaryDocumentId: second }, { primaryDocumentId: first, secondaryDocumentId: second }]), { code: 'BATCH_LIMIT' });
});

test('annotation snapshots compare by entity id and review arrangements are explicitly descriptors', async () => {
  const state = new WorkspaceStateStore((id) => id === first || id === second); state.createEntity(first, 'annotations', { id: 'same', text: 'old' }); state.createEntity(first, 'annotations', { id: 'gone' }); state.createEntity(second, 'annotations', { id: 'same', text: 'new' }); state.createEntity(second, 'annotations', { id: 'new' });
  const service = new ComparisonService({ store: fakeStore(), workspaceState: state, pdfService: { inspect: async () => ({ pageCount: 1 }), extractText: async () => [{ page: 1, text: '' }], renderThumbnail: async () => png([0, 0, 0, 255]) } });
  assert.deepEqual((await service.compareAnnotations(first, second)).stats, { added: 1, deleted: 1, changed: 1, unchanged: 0 });
  assert.equal((await service.describeOverlay(first, second)).rendered, false); assert.equal((await service.describeSideBySide(first, second)).status, 'descriptor-only');
  const crossFormat = await service.compareCrossFormat(first, second); assert.equal(crossFormat.conversionPerformed, false);
});

test('comparison rejects cancelled work and document page counts beyond its configured bound', async () => {
  const controller = new AbortController(); controller.abort();
  const pdf = { inspect: async () => ({ pageCount: 2 }), extractText: async () => [], renderThumbnail: async () => png([0, 0, 0, 255]) };
  const service = new ComparisonService({ store: fakeStore(), pdfService: pdf, limits: { maxPages: 1 } });
  await assert.rejects(service.compareContent(first, second, { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  await assert.rejects(service.compareContent(first, second), { code: 'COMPARISON_PAGE_LIMIT', status: 422 });
});

test('installed Poppler renders local pages for deterministic pixel evidence', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo'].map((path) => access(path))); } catch { context.skip('The fixed Poppler render toolchain is not installed.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'platen-compare-test-')); const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose()); const registry = new EngineRegistry(); const pdf = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const left = await store.createDocument({ stream: Readable.from([makeTextPdf('LEFT VERSION')]), displayName: 'left.pdf' }); const right = await store.createDocument({ stream: Readable.from([makeTextPdf('RIGHT VERSION')]), displayName: 'right.pdf' }); const service = new ComparisonService({ store, pdfService: pdf });
  const report = await service.comparePixels(left.id, right.id, { dpi: 72 }); assert.equal(report.pages[0].status, 'compared'); assert.ok(report.pages[0].comparedPixels > 0); assert.equal(await store.verifySource(left.id), true);
});
