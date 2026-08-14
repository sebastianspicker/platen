import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  inspectPdfAcroFormCheckbox,
  preparePdfAcroFormCheckbox,
  PDF_ACROFORM_CHECKBOX_PROFILE,
  PDF_ACROFORM_CHECKBOX_STATE_NAME,
} from '../scripts/host/pdf-acroform-checkbox-writer.mjs';

function fixture() {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>'],
    [4, '<< /Length 0 >>\nstream\n\nendstream'],
    [5, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 6 0 R >>'],
    [6, '<< /Length 0 >>\nstream\n\nendstream'],
  ]);
  for (const [number, body] of bodies) { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 7\n0000000000 65535 f \n${[1, 2, 3, 4, 5, 6].map((number) => `${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function request(source, extra = {}) { return { profile: PDF_ACROFORM_CHECKBOX_PROFILE, sourceSha256: digest(source), page: 1, fieldName: 'Approval.☑', rect: { x: 72, y: 700, width: 24, height: 24 }, ...extra }; }

test('AcroForm checkbox writer appends deterministic unchecked widget topology and reopens independently', () => {
  const source = fixture(); const normalized = request(source); const prepared = preparePdfAcroFormCheckbox(source, normalized);
  assert.equal(prepared.proof.stateName, PDF_ACROFORM_CHECKBOX_STATE_NAME);
  assert.equal(prepared.proof.sourcePrefixPreserved, true);
  assert.equal(prepared.proof.objectCount, 4);
  assert.equal(prepared.proof.fieldNameSha256, digest(Buffer.from(normalized.fieldName, 'utf8')));
  const proof = inspectPdfAcroFormCheckbox(source, prepared.bytes, normalized);
  assert.deepEqual(proof.references, prepared.proof.references);
  assert.equal(proof.rect.width, 24);
  assert.equal(proof.stateName, 'Yes');
  assert.deepEqual(inspectPdfAcroFormCheckbox(source, Buffer.from(prepared.bytes), normalized), proof);
});

test('AcroForm checkbox writer rejects digest drift, hostile geometry/names, aliases, and active structures', () => {
  const source = fixture();
  assert.throws(() => preparePdfAcroFormCheckbox(source, request(source, { sourceSha256: '0'.repeat(64) })), { code: 'INVALID_PDF_ACROFORM_CHECKBOX' });
  assert.throws(() => preparePdfAcroFormCheckbox(source, request(source, { rect: { x: 600, y: 780, width: 24, height: 24 } })), { code: 'INVALID_PDF_ACROFORM_CHECKBOX' });
  assert.throws(() => preparePdfAcroFormCheckbox(source, request(source, { fieldName: 'e\u0301' })), { code: 'INVALID_PDF_ACROFORM_CHECKBOX' });
  const tampered = Buffer.from(preparePdfAcroFormCheckbox(source, request(source)).bytes); tampered[tampered.length - 20] ^= 1;
  assert.throws(() => inspectPdfAcroFormCheckbox(source, tampered, request(source)), { code: 'INVALID_PDF_ACROFORM_CHECKBOX_OUTPUT' });
  const prepared = preparePdfAcroFormCheckbox(source, request(source));
  for (const [needle, replacement] of [['/Ff 0', '/Ff 1'], ['/FormType 1', '/FormType 2'], ['/Rect [72 700 96 724]', '/Rect [73 700 97 724]']]) {
    const changed = Buffer.from(prepared.bytes); const offset = changed.indexOf(Buffer.from(needle, 'latin1')); assert.ok(offset >= 0); Buffer.from(replacement, 'latin1').copy(changed, offset);
    assert.throws(() => inspectPdfAcroFormCheckbox(source, changed, request(source)), { code: 'INVALID_PDF_ACROFORM_CHECKBOX_OUTPUT' });
  }
  const unrelated = Buffer.from(prepared.bytes); const resourceOffset = unrelated.indexOf(Buffer.from('/Resources << >>', 'latin1')); assert.ok(resourceOffset >= 0); Buffer.from('/Resources << /X 1 >>', 'latin1').copy(unrelated, resourceOffset);
  assert.throws(() => inspectPdfAcroFormCheckbox(source, unrelated, request(source)), { code: 'INVALID_PDF_ACROFORM_CHECKBOX_OUTPUT' });
});

test('AcroForm checkbox writer rejects existing forms and active content before writing', () => {
  const source = fixture();
  const active = Buffer.from(source.toString('latin1').replace('/Resources << >>', '/Resources << /JavaScript 7 0 R >>'), 'latin1');
  assert.throws(() => preparePdfAcroFormCheckbox(active, request(active)), { code: 'UNSUPPORTED_PDF_ACROFORM_CHECKBOX_SOURCE' });
});
