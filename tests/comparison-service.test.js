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
function fakeStore() { const docs = new Map([[first, { id: first, mediaType: 'application/pdf', sha256: 'a'.repeat(64), size: 1 }], [second, { id: second, mediaType: 'application/pdf', sha256: 'b'.repeat(64), size: 1 }]]); return { getDocument: (id) => { if (!docs.has(id)) throw Object.assign(new Error('missing'), { code: 'DOCUMENT_NOT_FOUND' }); return docs.get(id); }, verifySource: async () => true }; }

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

test('annotation snapshots compare by entity id, overlays render, and side-by-side returns independent panes', async () => {
  const state = new WorkspaceStateStore((id) => id === first || id === second); state.createEntity(first, 'annotations', { id: 'same', text: 'old' }); state.createEntity(first, 'annotations', { id: 'gone' }); state.createEntity(second, 'annotations', { id: 'same', text: 'new' }); state.createEntity(second, 'annotations', { id: 'new' });
  const render = async (id) => encodeRgbaPng({ width: 2, height: 1, pixels: Buffer.from(id === first ? [0, 0, 0, 255, 255, 255, 255, 255] : [255, 255, 255, 255, 0, 0, 0, 255]) });
  const service = new ComparisonService({ store: fakeStore(), workspaceState: state, pdfService: { inspect: async () => ({ pageCount: 1 }), extractText: async () => [{ page: 1, text: '' }], renderThumbnail: render, renderOverlayPageExactDpi: render } });
  assert.deepEqual((await service.compareAnnotations(first, second)).stats, { added: 1, deleted: 1, changed: 1, unchanged: 0 });
  const overlay = await service.describeOverlay(first, second, { opacity: 0.5 });
  assert.equal(overlay.kind, 'overlay'); assert.equal(overlay.dpi, 72); assert.equal(overlay.semantics, 'primary-red-secondary-cyan');
  assert.equal(overlay.image.sha256.length, 64); assert.equal(overlay.validation.outputSha256, overlay.image.sha256);
  assert.deepEqual(decodePng(Buffer.from(overlay.image.data, 'base64')).pixels, Buffer.from([255, 0, 0, 255, 127, 255, 255, 255]));
  const sideBySide = await service.describeSideBySide(first, second);
  assert.equal(sideBySide.kind, 'side-by-side');
  assert.equal(sideBySide.dpi, 72);
  assert.equal(sideBySide.semantics, 'primary-left-secondary-right');
  assert.deepEqual(sideBySide.panes.map(({ role }) => role), ['primary', 'secondary']);
  assert.deepEqual(sideBySide.panes.map(({ width, height }) => ({ width, height })), [{ width: 2, height: 1 }, { width: 2, height: 1 }]);
  assert.deepEqual(sideBySide.panes.map(({ data }) => decodePng(Buffer.from(data, 'base64')).pixels), [
    Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]),
    Buffer.from([255, 255, 255, 255, 0, 0, 0, 255]),
  ]);
  assert.equal(sideBySide.validation.sourceReread, true);
  const crossFormat = await service.compareCrossFormat(first, second); assert.equal(crossFormat.conversionPerformed, false);
});

test('rendered comparisons reject unpaired pages, unavailable renderers, and output-limit overruns', async () => {
  const unpaired = new ComparisonService({ store: fakeStore(), pdfService: { inspect: async (id) => ({ pageCount: id === first ? 1 : 2 }), extractText: async () => [], renderThumbnail: async () => png([0, 0, 0, 255]) } });
  await assert.rejects(unpaired.describeOverlay(first, second, { page: 2 }), { code: 'OVERLAY_UNPAIRED_PAGE', status: 422 });
  await assert.rejects(unpaired.describeSideBySide(first, second, { page: 2 }), { code: 'SIDE_BY_SIDE_UNPAIRED_PAGE', status: 422 });
  await assert.rejects(
    new ComparisonService({ store: fakeStore(), pdfService: { inspect: async () => ({ pageCount: 1 }), extractText: async () => [], renderThumbnail: async () => png([0, 0, 0, 255]) } }).describeSideBySide(first, second),
    { code: 'SIDE_BY_SIDE_RENDER_UNAVAILABLE', status: 503 },
  );
  const mismatchRender = async (id) => id === first ? png([0, 0, 0, 255]) : encodeRgbaPng({ width: 2, height: 1, pixels: Buffer.alloc(8, 255) });
  const mismatch = new ComparisonService({ store: fakeStore(), pdfService: { inspect: async () => ({ pageCount: 1 }), extractText: async () => [], renderThumbnail: mismatchRender, renderOverlayPageExactDpi: mismatchRender } });
  await assert.rejects(mismatch.describeOverlay(first, second), { code: 'OVERLAY_DIMENSION_MISMATCH', status: 422 });
  const cappedRender = async () => png([0, 0, 0, 255]);
  const capped = new ComparisonService({ store: fakeStore(), limits: { maxDifferenceImageBytes: 1 }, pdfService: { inspect: async () => ({ pageCount: 1 }), extractText: async () => [], renderThumbnail: cappedRender, renderOverlayPageExactDpi: cappedRender } });
  await assert.rejects(capped.describeOverlay(first, second), { code: 'OVERLAY_IMAGE_LIMIT', status: 413 });
  await assert.rejects(capped.describeSideBySide(first, second), { code: 'SIDE_BY_SIDE_IMAGE_LIMIT', status: 413 });
});

test('comparison rejects cancelled work and document page counts beyond its configured bound', async () => {
  const controller = new AbortController(); controller.abort();
  const pdf = { inspect: async () => ({ pageCount: 2 }), extractText: async () => [], renderThumbnail: async () => png([0, 0, 0, 255]) };
  const service = new ComparisonService({ store: fakeStore(), pdfService: pdf, limits: { maxPages: 1 } });
  await assert.rejects(service.compareContent(first, second, { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  await assert.rejects(service.describeOverlay(first, second, { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  await assert.rejects(service.compareContent(first, second), { code: 'COMPARISON_PAGE_LIMIT', status: 422 });
});

test('comparison maps cancellation and deadlines that arrive during the final source reread', async () => {
  const pdf = {
    inspect: async () => ({ pageCount: 1 }), extractText: async () => [{ page: 1, text: 'stable' }],
    renderThumbnail: async () => png([0, 0, 0, 255]),
  };
  const controller = new AbortController(); let cancelledReads = 0;
  const cancelledStore = {
    ...fakeStore(),
    verifySource: async () => { cancelledReads += 1; if (cancelledReads >= 3) controller.abort(); return true; },
  };
  await assert.rejects(
    new ComparisonService({ store: cancelledStore, pdfService: pdf }).compareContent(first, second, { signal: controller.signal }),
    { code: 'JOB_CANCELLED', status: 499 },
  );
  let timedReads = 0;
  const deadlineStore = {
    ...fakeStore(),
    verifySource: async () => {
      timedReads += 1;
      if (timedReads >= 3) await new Promise((resolve) => setTimeout(resolve, 25));
      return true;
    },
  };
  await assert.rejects(
    new ComparisonService({ store: deadlineStore, pdfService: pdf, limits: { deadlineMs: 10 } }).compareContent(first, second),
    { code: 'COMPARISON_TIMEOUT', status: 504 },
  );
});

test('installed Poppler renders local pages for deterministic pixel evidence', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo'].map((path) => access(path))); } catch { context.skip('The fixed Poppler render toolchain is not installed.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'platen-compare-test-')); const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose()); const registry = new EngineRegistry(); const pdf = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const left = await store.createDocument({ stream: Readable.from([makeTextPdf('LEFT VERSION')]), displayName: 'left.pdf' }); const right = await store.createDocument({ stream: Readable.from([makeTextPdf('RIGHT VERSION')]), displayName: 'right.pdf' }); const service = new ComparisonService({ store, pdfService: pdf });
  const report = await service.comparePixels(left.id, right.id, { dpi: 72 }); assert.equal(report.pages[0].status, 'compared'); assert.ok(report.pages[0].comparedPixels > 0); assert.equal(await store.verifySource(left.id), true);
  const overlay = await service.describeOverlay(left.id, right.id, { page: 1, opacity: 0.5 });
  const rendered = decodePng(Buffer.from(overlay.image.data, 'base64'));
  assert.deepEqual({ width: rendered.width, height: rendered.height }, { width: 612, height: 792 });
  const rotatedLeft = await store.createDocument({ stream: Readable.from([makeTextPdf('LEFT ROTATED', { rotations: [90] })]), displayName: 'left-rotated.pdf' });
  const rotatedRight = await store.createDocument({ stream: Readable.from([makeTextPdf('RIGHT ROTATED', { rotations: [90] })]), displayName: 'right-rotated.pdf' });
  const rotated = await service.describeOverlay(rotatedLeft.id, rotatedRight.id, { page: 1, opacity: 0.5 });
  const rotatedRaster = decodePng(Buffer.from(rotated.image.data, 'base64'));
  assert.deepEqual({ width: rotatedRaster.width, height: rotatedRaster.height }, { width: 792, height: 612 });
});
