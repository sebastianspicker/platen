import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { PDF_PRINTER_MARKS_PROFILE, inspectPdfPrinterMarks, writePdfPrinterMarks } from '../scripts/host/pdf-printer-marks-writer.mjs';

function request(source, pages = [1]) { return { profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256: createHash('sha256').update(source).digest('hex'), pages }; }
function source() { return makeMultiPagePdf(['one', 'two', 'three'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]], bleedBoxes: [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]], trimBoxes: [[18, 18, 594, 774], [18, 18, 594, 774], [18, 18, 594, 774]] }); }

test('printer-marks writer appends deterministic resource-free marks only to selected pages', () => {
  const input = source(); const req = request(input, [1, 3]); const first = writePdfPrinterMarks(input, req); const second = writePdfPrinterMarks(input, req);
  assert.deepEqual(first.bytes, second.bytes); assert.equal(first.bytes.subarray(0, input.length).equals(input), true); assert.equal(first.proof.pages.length, 2); assert.equal(first.proof.revisionCount, 2); assert.equal(first.proof.resourcesAdded, false); assert.equal(first.proof.onlySelectedPagesChanged, true);
  for (const page of first.proof.pages) { assert.equal(page.foundationEdit.operatorCounts.S, 8); assert.equal(page.foundationEdit.operatorCounts.q, 1); assert.equal(page.foundationEdit.operatorCounts.Q, 1); assert.ok(page.lines.every((line) => line.every(Number.isFinite))); }
  assert.deepEqual(inspectPdfPrinterMarks(input, first.bytes, req), first.proof);
});

test('printer-marks writer rejects malformed selections, missing boxes, no margin, and active sources', () => {
  const input = source();
  assert.throws(() => writePdfPrinterMarks(input, request(input, [2, 1])), { code: 'INVALID_PDF_PRINTER_MARKS' });
  assert.throws(() => writePdfPrinterMarks(input, request(input, [1, 1])), { code: 'INVALID_PDF_PRINTER_MARKS' });
  const noBleed = makeMultiPagePdf(['one'], { cropBoxes: [[8, 8, 604, 784]] });
  assert.throws(() => writePdfPrinterMarks(noBleed, request(noBleed)), { code: 'UNSUPPORTED_PDF_PRINTER_MARKS' });
  const noMargin = makeMultiPagePdf(['one'], { cropBoxes: [[8, 8, 604, 784]], bleedBoxes: [[0, 0, 612, 792]], trimBoxes: [[3, 3, 609, 789]] });
  assert.throws(() => writePdfPrinterMarks(noMargin, request(noMargin)), { code: 'UNSUPPORTED_PDF_PRINTER_MARKS' });
  const clippedBleed = makeMultiPagePdf(['one'], { cropBoxes: [[8, 8, 604, 784]], bleedBoxes: [[0, 0, 612, 792]], trimBoxes: [[18, 18, 594, 774]] }).toString('latin1').replace('/CropBox [8 8 604 784]', '/CropBox [20 20 590 770]');
  const clipped = Buffer.from(clippedBleed, 'latin1'); assert.throws(() => writePdfPrinterMarks(clipped, request(clipped)), { code: 'UNSUPPORTED_PDF_PRINTER_MARKS' });
  const tagged = makeMultiPagePdf(['one'], { cropBoxes: [[8, 8, 604, 784]], bleedBoxes: [[0, 0, 612, 792]], trimBoxes: [[18, 18, 594, 774]], tagged: true });
  assert.throws(() => writePdfPrinterMarks(tagged, request(tagged)), { code: 'UNSUPPORTED_PDF_PRINTER_MARKS' });
});

test('printer-marks inspection rejects tampering and request/source drift', () => {
  const input = source(); const req = request(input, [1]); const result = writePdfPrinterMarks(input, req); const tampered = Buffer.from(result.bytes); tampered[tampered.length - 20] ^= 1;
  assert.throws(() => inspectPdfPrinterMarks(input, tampered, req), { code: 'INVALID_PDF_PRINTER_MARKS_OUTPUT' });
  assert.throws(() => writePdfPrinterMarks(input, { ...req, sourceSha256: '0'.repeat(64) }), { code: 'INVALID_PDF_PRINTER_MARKS' });
  assert.throws(() => inspectPdfPrinterMarks(input, result.bytes, request(input, [2])), { code: 'INVALID_PDF_PRINTER_MARKS_OUTPUT' });
});
