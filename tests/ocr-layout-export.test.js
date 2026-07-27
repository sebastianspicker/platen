import assert from 'node:assert/strict';
import test from 'node:test';
import { ocrLayoutHtml, ocrTableCsv } from '../src/core/ocr-layout-export.js';

test('browser OCR layout export positions escaped local words without executable content', () => {
  const html = ocrLayoutHtml({ records: [{
    page: 1, pageSize: { widthPoints: 612, heightPoints: 792 },
    layout: { words: [{ text: '<script>alert(1)</script>', confidence: 92.5, bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 } }] },
  }] });
  assert.match(html, /left:10\.0000%;top:20\.0000%/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /positioned-ocr-review-v1/);
});

test('browser OCR layout export rejects out-of-page geometry', () => {
  assert.throws(() => ocrLayoutHtml({ records: [{ page: 1, pageSize: { widthPoints: 1, heightPoints: 1 }, layout: { words: [{ text: 'x', bounds: { x: 0.9, y: 0, width: 0.2, height: 1 } }] } }] }), { code: 'OCR_LAYOUT_INVALID' });
});

test('browser OCR table export emits RFC 4180 rows and neutralizes spreadsheet formulas', () => {
  const result = { records: [{ tableCandidates: [{ grid: [
    [{ text: 'Name' }, { text: 'Value' }],
    [{ text: '=CMD()' }, { text: 'A "quoted"\nvalue' }],
  ] }] }] };
  assert.equal(ocrTableCsv(result), '"Name","Value"\r\n"\'=CMD()","A ""quoted""\nvalue"\r\n');
});

test('browser OCR table export rejects malformed grids and oversized cells', () => {
  assert.throws(() => ocrTableCsv({ records: [{ tableCandidates: [{ grid: [[{ text: 'A' }, { text: 'B' }], [{ text: 'C' }]] }] }] }), { code: 'OCR_LAYOUT_INVALID' });
  assert.throws(() => ocrTableCsv({ records: [{ tableCandidates: [{ grid: [[{ text: 'A'.repeat(4_001) }, { text: 'B' }], [{ text: 'C' }, { text: 'D' }]] }] }] }), { code: 'OCR_LAYOUT_INVALID' });
});
