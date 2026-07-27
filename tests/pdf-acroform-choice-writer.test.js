import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectPdfAcroFormChoice, preparePdfAcroFormChoice, PDF_ACROFORM_CHOICE_PROFILE } from '../scripts/host/pdf-acroform-choice-writer.mjs';

function source() {
  const chunks = ['%PDF-1.7\n'];
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  const offsets = [];
  for (let index = 0; index < bodies.length; index += 1) { offsets.push(Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${index + 1} 0 obj\n${bodies[index]}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 5\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function request(bytes, overrides = {}) { return { profile: PDF_ACROFORM_CHOICE_PROFILE, sourceSha256: digest(bytes), page: 1, fieldName: 'Choice', rect: { x: 36, y: 700, width: 180, height: 20 }, options: [{ label: 'First' }, { label: 'Second' }], ...overrides }; }

test('choice writer emits deterministic unchecked non-combo list/choice field and reopens it independently', () => {
  const bytes = source(); const prepared = preparePdfAcroFormChoice(bytes, request(bytes));
  assert.equal(prepared.proof.combo, false); assert.equal(prepared.proof.options.length, 2); assert.equal(prepared.proof.sourcePrefixPreserved, true);
  assert.deepEqual(inspectPdfAcroFormChoice(bytes, prepared.bytes, request(bytes)), prepared.proof);
});

test('choice writer rejects hostile labels, duplicate options, geometry, source drift, and output tampering', () => {
  const bytes = source();
  assert.throws(() => preparePdfAcroFormChoice(bytes, request(bytes, { options: [{ label: 'Same' }, { label: 'Same' }] })), { code: 'INVALID_PDF_ACROFORM_CHOICE' });
  assert.throws(() => preparePdfAcroFormChoice(bytes, request(bytes, { options: [{ label: '\u0000' }, { label: 'Two' }] })), { code: 'INVALID_PDF_ACROFORM_CHOICE' });
  assert.throws(() => preparePdfAcroFormChoice(bytes, request(bytes, { rect: { x: 600, y: 700, width: 20, height: 20 } })), { code: 'INVALID_PDF_ACROFORM_CHOICE' });
  assert.throws(() => preparePdfAcroFormChoice(bytes, request(bytes, { sourceSha256: '0'.repeat(64) })), { code: 'INVALID_PDF_ACROFORM_CHOICE' });
  const prepared = preparePdfAcroFormChoice(bytes, request(bytes)); const tampered = Buffer.from(prepared.bytes); tampered[tampered.length - 8] ^= 1;
  assert.throws(() => inspectPdfAcroFormChoice(bytes, tampered, request(bytes)), { code: 'INVALID_PDF_ACROFORM_CHOICE_OUTPUT' });
});
