import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { PDF_PAGE_BACKGROUND_PROFILE, normalizePdfPageBackground } from '../scripts/host/pdf-page-background-contract.mjs';
import { inspectPdfPageBackground, writePdfPageBackground } from '../scripts/host/pdf-page-background-writer.mjs';

function source() { return makeMultiPagePdf(['one', 'two', 'three'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]], bleedBoxes: [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]], trimBoxes: [[18, 18, 594, 774], [18, 18, 594, 774], [18, 18, 594, 774]] }); }
function request(bytes, pages = [1, 3]) { return { profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: createHash('sha256').update(bytes).digest('hex'), pages, color: { r: 0.1, g: 0.2, b: 0.3 } }; }

test('page-background writer prepends deterministic canonical RGB fills to selected pages', () => {
  const input = source(); const req = request(input); const first = writePdfPageBackground(input, req); const second = writePdfPageBackground(input, req);
  assert.deepEqual(first.bytes, second.bytes); assert.ok(first.bytes.subarray(0, input.length).equals(input)); assert.equal(first.proof.pages.length, 2); assert.equal(first.proof.pages[0].stream.bytes > 0, true); assert.deepEqual(inspectPdfPageBackground(input, first.bytes, req), first.proof);
});

test('page-background rejects malformed selections, rotated pages, and unequal boxes', () => {
  const input = source(); assert.throws(() => writePdfPageBackground(input, request(input, [2, 1])), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
  const rotated = makeMultiPagePdf(['one'], { rotations: [90], cropBoxes: [[0, 0, 612, 792]] }); assert.throws(() => writePdfPageBackground(rotated, request(rotated, [1])), { code: 'UNSUPPORTED_PDF_PAGE_BACKGROUND' });
  const unequal = makeMultiPagePdf(['one'], { cropBoxes: [[1, 1, 611, 791]] }); assert.throws(() => writePdfPageBackground(unequal, request(unequal, [1])), { code: 'UNSUPPORTED_PDF_PAGE_BACKGROUND' });
});

test('page-background contract rejects accessors, symbols, extras, and over-precise colors', () => {
  const input = source(); const req = request(input);
  assert.throws(() => normalizePdfPageBackground({ ...req, extra: true }), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
  assert.throws(() => normalizePdfPageBackground({ ...req, color: { r: 0.0000001, g: 0, b: 0 } }), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
  const pages = [1]; Object.defineProperty(pages, '0', { get() { return 1; }, enumerable: true }); assert.throws(() => normalizePdfPageBackground({ ...req, pages }), { code: 'INVALID_PDF_PAGE_BACKGROUND' });
});

test('page-background inspection rejects output tampering', () => {
  const input = source(); const req = request(input); const result = writePdfPageBackground(input, req); const tampered = Buffer.from(result.bytes); tampered[tampered.length - 20] ^= 1;
  assert.throws(() => inspectPdfPageBackground(input, tampered, req), { code: 'INVALID_PDF_PAGE_BACKGROUND_OUTPUT' });
});
