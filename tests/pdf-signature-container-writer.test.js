import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  embedDetachedCms,
  getPreparedPdfSignatureBytesToSign,
  inspectPdfSignatureContainer,
  preparePdfSignatureContainer,
} from '../scripts/host/pdf-signature-container-writer.mjs';

function fixture({ pageExtra = '', catalogExtra = '' } = {}) {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  const bodies = new Map([
    [1, `<< /Type /Catalog /Pages 2 0 R${catalogExtra} >>`],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R${pageExtra} >>`],
    [4, '<< /Length 0 >>\nstream\n\nendstream'],
  ]);
  for (const [number, body] of bodies) { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 5\n0000000000 65535 f \n${[1, 2, 3, 4].map((number) => `${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function request(source, extra = {}) {
  return { profile: 'local-pdf-signature-container-v1', sourceSha256: createHash('sha256').update(source).digest('hex'), page: 1, fieldName: 'Signature 1', reason: 'Test', location: 'Local', contact: '', placeholderBytes: 4096, ...extra };
}

test('signature container preparation and DER embedding are deterministic and source-bound', () => {
  const source = fixture(); const input = request(source); const cms = Buffer.from([0x30, 0x04, 1, 2, 3, 0]);
  const first = preparePdfSignatureContainer(source, input); const second = preparePdfSignatureContainer(source, input);
  assert.deepEqual(first.bytes, second.bytes); assert.deepEqual(first.proof, second.proof);
  const signed = getPreparedPdfSignatureBytesToSign(first); assert.equal(signed.length, first.proof.byteRange[1] + first.proof.byteRange[3]);
  signed[0] ^= 0xff; assert.notDeepEqual(signed, getPreparedPdfSignatureBytesToSign(first));
  const final = embedDetachedCms(first, cms); assert.equal(final.bytes.length, first.bytes.length);
  assert.equal(final.proof.cmsBytes, cms.length); assert.equal(final.proof.contentsPaddingBytes, 4096 - cms.length);
  assert.deepEqual(inspectPdfSignatureContainer(source, final.bytes, input, final.proof.cmsSha256), final.proof);
});

test('signature container rejects hostile requests, hazards, oversized or non-DER CMS, and tampering', () => {
  const source = fixture(); const input = request(source);
  const getterRequest = { ...input }; Object.defineProperty(getterRequest, 'reason', { enumerable: true, get() { throw new Error('getter invoked'); } });
  assert.throws(() => preparePdfSignatureContainer(source, getterRequest), { code: 'INVALID_PDF_SIGNATURE_CONTAINER' });
  assert.throws(() => preparePdfSignatureContainer(source, { ...input, placeholderBytes: 1024 }), { code: 'INVALID_PDF_SIGNATURE_CONTAINER' });
  assert.throws(() => preparePdfSignatureContainer(source, { ...input, fieldName: 'e\u0301' }), { code: 'INVALID_PDF_SIGNATURE_CONTAINER' });
  const prepared = preparePdfSignatureContainer(source, input);
  assert.throws(() => embedDetachedCms(prepared, Buffer.alloc(4097)), { code: 'INVALID_PDF_SIGNATURE_CONTAINER' });
  assert.throws(() => embedDetachedCms(prepared, Buffer.from([1, 2, 3])), { code: 'INVALID_PDF_SIGNATURE_CONTAINER' });
  const cms = Buffer.from([0x30, 0x04, 1, 2, 3, 0]); const final = embedDetachedCms(prepared, cms);
  const tampered = Buffer.from(final.bytes); const marker = tampered.indexOf(Buffer.from('/ByteRange [', 'latin1')); tampered[marker + 13] = 0x39;
  assert.throws(() => inspectPdfSignatureContainer(source, tampered, input, final.proof.cmsSha256), { code: 'INVALID_PDF_SIGNATURE_CONTAINER_OUTPUT' });
  assert.throws(() => preparePdfSignatureContainer(fixture({ pageExtra: ' /Annots []' }), request(fixture({ pageExtra: ' /Annots []' }))), { code: 'UNSUPPORTED_PDF_SIGNATURE_CONTAINER_SOURCE' });
  assert.throws(() => preparePdfSignatureContainer(fixture({ catalogExtra: ' /AcroForm 9 0 R' }), request(fixture({ catalogExtra: ' /AcroForm 9 0 R' }))), { code: 'UNSUPPORTED_PDF_SIGNATURE_CONTAINER_SOURCE' });
});
