import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectPdfAcroFormTextField, preparePdfAcroFormTextField, PDF_ACROFORM_TEXT_FIELD_PROFILE } from '../scripts/host/pdf-acroform-text-field-writer.mjs';

function fixture(extra = '') {
  const bodies = new Map([[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>'], [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>'], [4, '<< /Length 0 >>\nstream\n\nendstream'], [5, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 6 0 R >>'], [6, '<< /Length 0 >>\nstream\n\nendstream']]);
  const chunks = ['%PDF-1.7\n']; const offsets = new Map(); for (const [number, body] of bodies) { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push(`xref\n0 7\n0000000000 65535 f \n${[1, 2, 3, 4, 5, 6].map((number) => `${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R${extra} >>\nstartxref\n${xref}\n%%EOF\n`); return Buffer.from(chunks.join(''), 'latin1');
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function request(source, extra = {}) { return { profile: PDF_ACROFORM_TEXT_FIELD_PROFILE, sourceSha256: digest(source), page: 1, fieldName: 'Account.Name', rect: { x: 72, y: 700, width: 180, height: 24 }, ...extra }; }

test('text-field writer emits one empty terminal widget and independently reopens it', () => {
  const source = fixture(); const prepared = preparePdfAcroFormTextField(source, request(source));
  assert.equal(prepared.proof.defaultEmpty, true); assert.equal(prepared.proof.objectCount, 4); assert.equal(prepared.proof.sourcePrefixPreserved, true);
  const proof = inspectPdfAcroFormTextField(source, prepared.bytes, request(source)); assert.deepEqual(proof.references, prepared.proof.references); assert.equal(proof.rect.width, 180); assert.equal(proof.otherPagesContentResourcesPreserved, true);
});

test('text-field writer rejects descriptor drift, hostile names and geometry, tampering, and unsafe sources', () => {
  const source = fixture();
  assert.throws(() => preparePdfAcroFormTextField(source, request(source, { sourceSha256: '0'.repeat(64) })), { code: 'INVALID_PDF_ACROFORM_TEXT_FIELD' });
  assert.throws(() => preparePdfAcroFormTextField(source, request(source, { fieldName: 'e\u0301' })), { code: 'INVALID_PDF_ACROFORM_TEXT_FIELD' });
  assert.throws(() => preparePdfAcroFormTextField(source, request(source, { fieldName: '\uE000' })), { code: 'INVALID_PDF_ACROFORM_TEXT_FIELD' });
  assert.throws(() => preparePdfAcroFormTextField(source, request(source, { fieldName: '\u0378' })), { code: 'INVALID_PDF_ACROFORM_TEXT_FIELD' });
  assert.throws(() => preparePdfAcroFormTextField(source, request(source, { fieldName: 'a'.repeat(128) })), { code: 'INVALID_PDF_ACROFORM_TEXT_FIELD' });
  assert.throws(() => preparePdfAcroFormTextField(source, request(source, { rect: { x: 600, y: 780, width: 24, height: 24 } })), { code: 'INVALID_PDF_ACROFORM_TEXT_FIELD' });
  const prepared = preparePdfAcroFormTextField(source, request(source)); const tampered = Buffer.from(prepared.bytes); tampered[tampered.length - 20] ^= 1; assert.throws(() => inspectPdfAcroFormTextField(source, tampered, request(source)), { code: 'INVALID_PDF_ACROFORM_TEXT_FIELD_OUTPUT' });
  const active = fixture(); const activeBytes = Buffer.from(active.toString('latin1').replace('/Resources << >>', '/Resources << /JavaScript 7 0 R >>'), 'latin1'); assert.throws(() => preparePdfAcroFormTextField(activeBytes, request(activeBytes)), { code: 'UNSUPPORTED_PDF_ACROFORM_TEXT_FIELD_SOURCE' });
  const encrypted = fixture(' /Encrypt 7 0 R'); assert.throws(() => preparePdfAcroFormTextField(encrypted, request(encrypted)), { code: 'UNSUPPORTED_PDF_ACROFORM_TEXT_FIELD_SOURCE' });
});

test('text-field writer rejects existing forms, widgets, actions, tags, and layers', () => {
  const variants = ['/AcroForm 7 0 R', '/Annots [7 0 R]', '/StructTreeRoot 7 0 R', '/OCProperties 7 0 R', '/OpenAction 7 0 R', '/ByteRange [0 1 2 3]', '/SubFilter /adbe.pkcs7.detached'];
  for (const marker of variants) { const source = fixture(); const changed = Buffer.from(source.toString('latin1').replace('<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Catalog /Pages 2 0 R ${marker} >>`), 'latin1'); assert.throws(() => preparePdfAcroFormTextField(changed, request(changed)), { code: 'UNSUPPORTED_PDF_ACROFORM_TEXT_FIELD_SOURCE' }); }
});

test('text-field writer requires a renderable Helvetica resource and DA', () => {
  const source = fixture(); const requestValue = request(source); const prepared = preparePdfAcroFormTextField(source, requestValue);
  const missingFont = Buffer.from(prepared.bytes); const fontOffset = missingFont.indexOf(Buffer.from('/BaseFont /Helvetica', 'latin1')); assert.ok(fontOffset >= 0); Buffer.from('/BaseFont /Courier  ', 'latin1').copy(missingFont, fontOffset);
  assert.throws(() => inspectPdfAcroFormTextField(source, missingFont, requestValue), { code: 'INVALID_PDF_ACROFORM_TEXT_FIELD_OUTPUT' });
  const badDa = Buffer.from(prepared.bytes); const daOffset = badDa.indexOf(Buffer.from('2F48656C7620313220546620302067', 'latin1')); assert.ok(daOffset >= 0); Buffer.from('2F6E6F6E6520313220546620302067', 'latin1').copy(badDa, daOffset);
  assert.throws(() => inspectPdfAcroFormTextField(source, badDa, requestValue), { code: 'INVALID_PDF_ACROFORM_TEXT_FIELD_OUTPUT' });
});
