import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makeMultiPagePdf, makeTextPdf } from './pdf-fixture.js';
import {
  PDF_JPEG_IMAGE_PROFILE,
  inspectPdfJpegImage,
  writePdfJpegImage,
} from '../scripts/host/pdf-jpeg-image-writer.mjs';

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==', 'base64');

function request(source, overrides = {}) {
  return {
    profile: PDF_JPEG_IMAGE_PROFILE,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    page: 1,
    rect: { x: 10, y: 20, width: 100, height: 80 },
    jpegBytes: JPEG,
    ...overrides,
  };
}

function directResourceFixture(alias = false) {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /CropBox [0 0 200 200] /Resources << /XObject << /Im0 4 0 R${alias ? ' /ImX 4 0 R' : ''} >> >> >>`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length 286 >>\nstream\n' + JPEG.toString('latin1') + '\nendstream',
  ];
  const chunks = ['%PDF-1.7\n']; const offsets = [];
  bodies.forEach((body, index) => { offsets[index + 1] = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`); });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push(`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

test('JPEG image insertion is source-bound, deterministic, CropBox-contained, and privately re-inspected', () => {
  const source = makeMultiPagePdf(['one', 'two'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]] });
  const result = writePdfJpegImage(source, request(source));
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(result.bytes.toString('latin1').includes('/Subtype /Image'), true);
  assert.deepEqual(inspectPdfJpegImage(source, result.bytes, request(source)), result.proof);
  assert.deepEqual(result.proof.image, { width: 1, height: 1, components: 3, bytes: JPEG.length, sha256: createHash('sha256').update(JPEG).digest('hex') });
  assert.equal(Object.hasOwn(result.proof, 'jpegBytes'), false);
});

test('JPEG insertion chooses a fresh XObject name and preserves the direct resource graph', () => {
  const source = directResourceFixture();
  const result = writePdfJpegImage(source, request(source, { rect: { x: 1, y: 2, width: 20, height: 30 } }));
  assert.equal(result.proof.resourceName, 'Im1');
  assert.equal(result.proof.placementMatrix.join(' '), '20 0 0 30 1 2');
  assert.throws(() => writePdfJpegImage(directResourceFixture(true), request(directResourceFixture(true))), { code: 'UNSUPPORTED_PDF_JPEG_IMAGE_SOURCE' });
});

test('JPEG insertion rejects malformed, progressive, hostile, inherited, and out-of-bounds inputs', () => {
  const source = makeMultiPagePdf(['one'], { cropBoxes: [[0, 0, 612, 792]] });
  assert.throws(() => writePdfJpegImage(source, request(source, { jpegBytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) })), { code: 'INVALID_PDF_JPEG_IMAGE' });
  const progressive = Buffer.from(JPEG); const sof = progressive.indexOf(Buffer.from([0xff, 0xc0])); progressive[sof + 1] = 0xc2;
  assert.throws(() => writePdfJpegImage(source, request(source, { jpegBytes: progressive })), { code: 'UNSUPPORTED_PDF_JPEG_IMAGE_SOURCE' });
  assert.throws(() => writePdfJpegImage(source, request(source, { rect: { x: 0, y: 0, width: 700, height: 10 } })), { code: 'UNSUPPORTED_PDF_JPEG_IMAGE_SOURCE' });
  assert.throws(() => writePdfJpegImage(makeTextPdf(), request(makeTextPdf())), { code: 'UNSUPPORTED_PDF_JPEG_IMAGE_SOURCE' });
  assert.throws(() => writePdfJpegImage(makeMultiPagePdf(['one'], { tagged: true, cropBoxes: [[0, 0, 612, 792]] }), request(makeMultiPagePdf(['one'], { tagged: true, cropBoxes: [[0, 0, 612, 792]] }))), { code: 'UNSUPPORTED_PDF_JPEG_IMAGE_SOURCE' });
});

test('JPEG insertion rejects output tampering and request/source drift', () => {
  const source = makeMultiPagePdf(['one'], { cropBoxes: [[0, 0, 612, 792]] }); const req = request(source); const result = writePdfJpegImage(source, req);
  const tampered = Buffer.from(result.bytes); tampered[tampered.length - 20] ^= 1;
  assert.throws(() => inspectPdfJpegImage(source, tampered, req), { code: 'INVALID_PDF_JPEG_IMAGE_OUTPUT' });
  assert.throws(() => writePdfJpegImage(source, { ...req, sourceSha256: '0'.repeat(64) }), { code: 'INVALID_PDF_JPEG_IMAGE' });
});

test('JPEG envelope admits legal entropy byte-stuffing but rejects invalid Huffman selectors', () => {
  const source = makeMultiPagePdf(['one'], { cropBoxes: [[0, 0, 612, 792]] });
  const stuffed = Buffer.concat([JPEG.subarray(0, -2), Buffer.from([0xff, 0x00]), JPEG.subarray(-2)]);
  assert.doesNotThrow(() => writePdfJpegImage(source, request(source, { jpegBytes: stuffed })));
  const invalidSelector = Buffer.from(JPEG); const sos = invalidSelector.indexOf(Buffer.from([0xff, 0xda])); invalidSelector[sos + 4] = 0x04;
  assert.throws(() => writePdfJpegImage(source, request(source, { jpegBytes: invalidSelector })), { code: 'INVALID_PDF_JPEG_IMAGE' });
});
