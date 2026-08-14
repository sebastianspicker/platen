import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { normalizePdfPageWatermark, PDF_PAGE_WATERMARK_PROFILE } from '../scripts/host/pdf-page-watermark-contract.mjs';
import { inspectPdfPageWatermark, writePdfPageWatermark } from '../scripts/host/pdf-page-watermark-writer.mjs';

function source(options = {}) { return makeMultiPagePdf(['one', 'two'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]], ...options }); }
function request(bytes, pages = [1]) { return { profile: PDF_PAGE_WATERMARK_PROFILE, sourceSha256: createHash('sha256').update(bytes).digest('hex'), pages, text: 'CONFIDENTIAL' }; }

test('watermark writer applies one deterministic opaque text stream to selected pages', () => {
  const input = source(); const req = request(input, [1]); const first = writePdfPageWatermark(input, req); const second = writePdfPageWatermark(input, req);
  assert.deepEqual(first.bytes, second.bytes); assert.ok(first.bytes.subarray(0, input.length).equals(input)); assert.deepEqual(inspectPdfPageWatermark(input, first.bytes, req), first.proof); assert.deepEqual(first.proof.pages, [{ page: 1, text: 'CONFIDENTIAL', applied: true }]);
});

test('watermark contract rejects malformed text, prototypes, symbols, extras, and accessors', () => {
  const input = source(); const req = request(input);
  assert.throws(() => normalizePdfPageWatermark({ ...req, extra: true }), { code: 'INVALID_PDF_PAGE_WATERMARK' });
  assert.throws(() => normalizePdfPageWatermark({ ...req, text: 'e\u0301' }), { code: 'INVALID_PDF_PAGE_WATERMARK' });
  const pages = [1]; Object.defineProperty(pages, '0', { get() { return 1; }, enumerable: true }); assert.throws(() => normalizePdfPageWatermark({ ...req, pages }), { code: 'INVALID_PDF_PAGE_WATERMARK' });
  const hostile = Object.create(null); Object.assign(hostile, req); assert.throws(() => normalizePdfPageWatermark(hostile), { code: 'INVALID_PDF_PAGE_WATERMARK' });
  const symbols = { ...req, [Symbol('extra')]: true }; assert.throws(() => normalizePdfPageWatermark(symbols), { code: 'INVALID_PDF_PAGE_WATERMARK' });
});

test('watermark writer rejects rotated and complex source pages and output tampering', () => {
  const rotated = source({ rotations: [90, 0] }); assert.throws(() => writePdfPageWatermark(rotated, request(rotated)), { code: 'UNSUPPORTED_PDF_PAGE_WATERMARK' });
  const input = source(); const req = request(input); const output = writePdfPageWatermark(input, req); const tampered = Buffer.from(output.bytes); tampered[tampered.length - 20] ^= 1; assert.throws(() => inspectPdfPageWatermark(input, tampered, req), { code: 'INVALID_PDF_PAGE_WATERMARK_OUTPUT' });
});
