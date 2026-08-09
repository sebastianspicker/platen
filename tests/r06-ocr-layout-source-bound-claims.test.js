import assert from 'node:assert/strict';
import test from 'node:test';
import { ocrLayoutHtml, ocrTableCsv } from '../src/core/ocr-layout-export.js';
import { validateOcrLayoutResult } from '../src/core/ocr-contract.js';
import { parseTesseractTsvHierarchy } from '../scripts/host/ocr-layout.mjs';
import { validateAltoEvidence } from '../scripts/host/pdf-ocr-helpers.mjs';
import { createRealOcrFixture, driftSource, enginesAvailable } from './support/r06-ocr-claim-fixtures.js';

async function requireEngines(context) {
  if (!await enginesAvailable()) {
    context.skip('The fixed Poppler, Tesseract, and ImageMagick OCR engines are unavailable.');
    return false;
  }
  return true;
}

test('R06 layout OCR proves source-bound zones, TSV hierarchy, ALTO evidence, and review exports', async (context) => {
  if (!await requireEngines(context)) return;
  const fixture = await createRealOcrFixture('R06 LAYOUT SOURCE');
  context.after(fixture.cleanup);
  const result = validateOcrLayoutResult(await fixture.service.analyzeOcrLayout(fixture.source.id, {
    language: 'eng',
    pages: [1],
    zones: [{ id: 'text-zone', type: 'text', page: 1, x: 0, y: 0, width: 1, height: 1 }],
    cleanupPreset: 'document',
    segmentation: 'block',
    detectTables: true,
  }));
  assert.equal(result.sourceDigest, fixture.source.sha256);
  assert.deepEqual(result.evidence.engines, ['Poppler', 'ImageMagick', 'Tesseract']);
  assert.equal(result.evidence.sourceBound, true);
  assert.equal(result.evidence.reviewRequired, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].classificationOnly, false);
  assert.ok(result.records[0].recognizedWordCount > 0);
  assert.equal(result.records[0].alto.mediaType, 'application/alto+xml');
  assert.match(result.records[0].alto.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(result.records[0].layout.words.every(({ bounds }) => bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1.000001 && bounds.y + bounds.height <= 1.000001));

  const html = ocrLayoutHtml(result);
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /Positioned OCR review/u);
  assert.doesNotMatch(html, /<script>/u);
  const tableResult = {
    records: [{ tableCandidates: [{ grid: [
      [{ text: 'Name' }, { text: 'Value' }],
      [{ text: '=CMD()' }, { text: 'A "quoted"\nvalue' }],
    ] }] }],
  };
  assert.equal(ocrTableCsv(tableResult), '"Name","Value"\r\n"\'=CMD()","A ""quoted""\nvalue"\r\n');
});

test('R06 layout OCR rejects hostile zones, source drift, cancellation, and bounded output requests', async (context) => {
  if (!await requireEngines(context)) return;
  const fixture = await createRealOcrFixture('R06 LAYOUT HOSTILE');
  context.after(fixture.cleanup);
  await assert.rejects(
    fixture.service.analyzeOcrLayout(fixture.source.id, {
      language: 'eng', pages: [1], cleanupPreset: 'none',
      zones: [
        { id: 'a', type: 'text', page: 1, x: 0, y: 0, width: 0.7, height: 0.7 },
        { id: 'b', type: 'table', page: 1, x: 0.6, y: 0.6, width: 0.4, height: 0.4 },
      ],
    }),
    { code: 'INVALID_OCR_ZONES', status: 400 },
  );
  await assert.rejects(
    fixture.service.analyzeOcrLayout(fixture.source.id, {
      language: 'eng', pages: [1], cleanupPreset: 'none',
      zones: Array.from({ length: 33 }, (_, index) => ({ id: `z${index}`, type: 'text', page: 1, x: 0, y: 0, width: 1, height: 1 })),
    }),
    { code: 'INVALID_OCR_ZONES', status: 400 },
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    fixture.service.analyzeOcrLayout(fixture.source.id, { language: 'eng', pages: [1], signal: cancelled.signal }),
    { code: 'JOB_CANCELLED', status: 499 },
  );

  await driftSource(fixture.store, fixture.source.id);
  await assert.rejects(
    fixture.service.analyzeOcrLayout(fixture.source.id, { language: 'eng', pages: [1], cleanupPreset: 'none' }),
    { code: 'PDF_PROCESSING_FAILED', status: 422 },
  );
});

test('R06 layout exports reject hostile geometry, malformed tables, and formula-bearing cells safely', () => {
  assert.throws(() => parseTesseractTsvHierarchy('not-tsv', { imageWidth: 100, imageHeight: 100 }), { code: 'OCR_TSV_INVALID' });
  assert.throws(() => validateAltoEvidence(Buffer.from('<alto/>')), { code: 'INVALID_ENGINE_OUTPUT' });
  assert.throws(() => ocrLayoutHtml({ records: [{ page: 1, pageSize: { widthPoints: 612, heightPoints: 792 }, layout: { words: [{ text: '<script>alert(1)</script>', confidence: 80, bounds: { x: 0.9, y: 0, width: 0.2, height: 1 } }] } }] }), { code: 'OCR_LAYOUT_INVALID' });
  assert.throws(() => ocrTableCsv({ records: [{ tableCandidates: [{ grid: [['A', 'B'], ['C']] }] }] }), { code: 'OCR_LAYOUT_INVALID' });
  assert.throws(() => ocrTableCsv({ records: [{ tableCandidates: [{ grid: [[{ text: 'A'.repeat(4_001), wordIds: [], bounds: null, truncated: false }, { text: 'B', wordIds: [], bounds: null, truncated: false }], [{ text: 'C', wordIds: [], bounds: null, truncated: false }, { text: 'D', wordIds: [], bounds: null, truncated: false }]] }] }] }), { code: 'OCR_LAYOUT_INVALID' });
});
