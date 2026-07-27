import assert from 'node:assert/strict';
import test from 'node:test';
import { exportOcrLayoutHtml, exportOcrLayoutJson, parseTesseractTsvHierarchy } from '../scripts/host/ocr-layout.mjs';
const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const rows = ['1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t', '2\t1\t1\t0\t0\t0\t0\t0\t100\t100\t-1\t', '3\t1\t1\t1\t0\t0\t0\t0\t100\t100\t-1\t', '4\t1\t1\t1\t1\t0\t0\t0\t100\t20\t-1\t', '5\t1\t1\t1\t1\t1\t0\t0\t20\t10\t90\tA', '5\t1\t1\t1\t1\t2\t30\t0\t20\t10\t90\tB', '4\t1\t1\t1\t2\t0\t0\t30\t100\t20\t-1\t', '5\t1\t1\t1\t2\t1\t0\t30\t20\t10\t90\tC', '5\t1\t1\t1\t2\t2\t30\t30\t20\t10\t90\t<script>'];
test('TSV hierarchy normalizes zones and honestly labels table heuristics', () => { const model = parseTesseractTsvHierarchy([header, ...rows].join('\n'), { imageWidth: 100, imageHeight: 100, zone: { x: 0.2, y: 0.1, width: 0.5, height: 0.5 } }); assert.equal(model.words[0].bounds.x, 0.2); assert.equal(model.tableCandidates[0].method, 'tesseract-tsv-geometry-heuristic'); assert.equal(model.tableCandidates[0].reviewRequired, true); assert.equal(model.tableCandidates[0].alignmentScore, 1); assert.equal(Object.hasOwn(model.tableCandidates[0], 'confidence'), false); assert.equal(model.tableCandidates[0].truncated, false); assert.equal(model.tableCandidates[0].grid[0][0].text, 'A'); assert.equal(model.tableCandidates[0].grid[1][1].text, '<script>'); const html = exportOcrLayoutHtml(model); assert.equal(html.includes('<script>'), false); assert.equal(html.includes('&lt;script&gt;'), true); assert.match(html, /position:absolute/); assert.match(html, /left:20\.0000%/); });

test('TSV table grids remain bounded and disclose truncated rows', () => {
  const thirdRow = [
    '4\t1\t1\t1\t3\t0\t0\t60\t100\t20\t-1\t',
    '5\t1\t1\t1\t3\t1\t0\t60\t20\t10\t90\tE',
    '5\t1\t1\t1\t3\t2\t30\t60\t20\t10\t90\tF',
  ];
  const model = parseTesseractTsvHierarchy([header, ...rows, ...thirdRow].join('\n'), { imageWidth: 100, imageHeight: 100, limits: { maxTableRows: 2 } });
  assert.equal(model.tableCandidates[0].grid.length, 2);
  assert.equal(model.tableCandidates[0].truncated, true);
});
test('TSV parser rejects malformed hierarchy and output limits', () => { assert.throws(() => parseTesseractTsvHierarchy('bad', { imageWidth: 1, imageHeight: 1 }), { code: 'OCR_TSV_INVALID' }); assert.throws(() => parseTesseractTsvHierarchy([header, rows[0], rows[4]].join('\n'), { imageWidth: 100, imageHeight: 100 }), { code: 'OCR_TSV_INVALID' }); const model = parseTesseractTsvHierarchy([header, ...rows].join('\n'), { imageWidth: 100, imageHeight: 100 }); assert.throws(() => exportOcrLayoutJson(model, 2), { code: 'OCR_LAYOUT_LIMIT' }); });

test('TSV accepts real fractional confidence but rejects duplicate hierarchy identifiers', () => {
  const fractional = rows.map((row) => row.endsWith('\t90\tA') ? row.replace('\t90\tA', '\t96.544746\tA') : row);
  const model = parseTesseractTsvHierarchy([header, ...fractional].join('\n'), { imageWidth: 100, imageHeight: 100 });
  assert.equal(model.words[0].confidence, 96.544746);
  assert.throws(() => parseTesseractTsvHierarchy([header, ...rows, rows.at(-1)].join('\n'), { imageWidth: 100, imageHeight: 100 }), { code: 'OCR_TSV_INVALID' });
});
