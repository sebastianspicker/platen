import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makeMultiPagePdf, makeTextPdf } from './pdf-fixture.js';
import { PDF_PAGE_LABELS_PROFILE, inspectPdfPageLabels, writePdfPageLabels } from '../scripts/host/pdf-page-labels-writer.mjs';

function request(source, ranges, overrides = {}) {
  return { profile: PDF_PAGE_LABELS_PROFILE, sourceSha256: createHash('sha256').update(source).digest('hex'), ranges, ...overrides };
}

test('page-label writer emits deterministic direct number-tree labels and proves every page', () => {
  const source = makeMultiPagePdf(['one', 'two', 'three', 'four'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]] });
  const result = writePdfPageLabels(source, request(source, [
    { start: 0, style: 'D', prefix: '§ ', startNumber: 1 },
    { start: 2, style: 'R', prefix: 'App ', startNumber: 4 },
  ]));
  assert.deepEqual(result.proof.labels, ['§ 1', '§ 2', 'App IV', 'App V']);
  assert.equal(result.proof.onlyCatalogChanged, true);
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  assert.deepEqual(inspectPdfPageLabels(source, result.bytes, request(source, [
    { start: 0, style: 'D', prefix: '§ ', startNumber: 1 },
    { start: 2, style: 'R', prefix: 'App ', startNumber: 4 },
  ])), result.proof);
});

test('page-label writer supports none, lower styles, letter rollover, and default leading pages', () => {
  const source = makeMultiPagePdf(['one', 'two', 'three', 'four', 'five'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]] });
  const result = writePdfPageLabels(source, request(source, [
    { start: 2, style: 'none', prefix: 'Plate ' },
    { start: 3, style: 'a', prefix: '', startNumber: 26 },
  ]));
  assert.deepEqual(result.proof.labels, ['1', '2', 'Plate ', 'z', 'aa']);
});

test('page-label writer rejects malformed ranges, unsafe prefixes, existing labels, and unsupported sources', () => {
  const source = makeMultiPagePdf(['one', 'two'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]] });
  const valid = (ranges) => request(source, ranges);
  assert.throws(() => writePdfPageLabels(source, valid([{ start: 1, style: 'D', startNumber: 1 }, { start: 1, style: 'D', startNumber: 1 }])), { code: 'INVALID_PDF_PAGE_LABELS' });
  assert.throws(() => writePdfPageLabels(source, valid([{ start: 2, style: 'D', startNumber: 1 }])), { code: 'INVALID_PDF_PAGE_LABELS' });
  assert.throws(() => writePdfPageLabels(source, valid([{ start: 0, style: 'D', prefix: 'bad\n', startNumber: 1 }])), { code: 'INVALID_PDF_PAGE_LABELS' });
  const text = makeTextPdf(); assert.throws(() => writePdfPageLabels(text, request(text, [{ start: 0, style: 'D', startNumber: 1 }])), { code: 'UNSUPPORTED_PDF_PAGE_LABELS_PDF' });
  const encrypted = Buffer.from(source.toString('latin1').replace(/\/Root (\d+ 0 R) >>\nstartxref/u, '/Root $1 /Encrypt 99 0 R >>\nstartxref'), 'latin1');
  assert.throws(() => writePdfPageLabels(encrypted, request(encrypted, [{ start: 0, style: 'D', startNumber: 1 }])), { code: 'UNSUPPORTED_PDF_PAGE_LABELS_PDF' });
});

test('page-label writer independently rejects output tampering and request/source drift', () => {
  const source = makeMultiPagePdf(['one', 'two'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]] }); const req = request(source, [{ start: 0, style: 'D', startNumber: 1 }]); const result = writePdfPageLabels(source, req);
  const tampered = Buffer.from(result.bytes); tampered[tampered.length - 18] ^= 1;
  assert.throws(() => inspectPdfPageLabels(source, tampered, req), { code: 'INVALID_PDF_PAGE_LABELS_OUTPUT' });
  assert.throws(() => writePdfPageLabels(source, { ...req, sourceSha256: '0'.repeat(64) }), { code: 'INVALID_PDF_PAGE_LABELS' });
});
