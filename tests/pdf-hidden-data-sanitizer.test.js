import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectPdfHiddenDataInventory } from '../scripts/host/pdf-hidden-data-inventory.mjs';
import {
  buildPdfHiddenDataSanitization,
  inspectPdfHiddenDataSanitization,
  verifyPdfHiddenDataSanitization,
} from '../scripts/host/pdf-hidden-data-sanitizer.mjs';
import { makeObjectStreamPdf } from './support/pdf-xref-stream-fixture.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function pdf(objects, trailer = '') {
  let body = '%PDF-1.7\n'; const offsets = [];
  for (let index = 0; index < objects.length; index += 1) { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(body, 'latin1'); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function hiddenPdf({ mixedNames = false } = {}) {
  return pdf([
    `<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R /Metadata 6 0 R /Names 7 0 R /StructTreeRoot 8 0 R >>`,
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Contents 4 0 R /Annots [9 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Action /S /JavaScript /JS (remove-me) >>',
    '<< /Type /Metadata /Subtype /XML /Length 0 >>',
    mixedNames ? '<< /EmbeddedFiles 10 0 R /Dests 11 0 R >>' : '<< /EmbeddedFiles 10 0 R >>',
    '<< /Type /StructTreeRoot /K [] >>',
    '<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] /Contents (comment) >>',
    '<< /Type /Filespec /F (secret.txt) /EF << /F 12 0 R >> >>',
    '<< /Names [] >>',
    '<< /Type /EmbeddedFile /Length 0 >>\nstream\n\nendstream',
  ]);
}

test('bounded hidden-data sanitizer removes enumerated classes, preserves page content streams, and proves closed residue-free output', () => {
  const source = hiddenPdf(); const before = inspectPdfHiddenDataInventory(source, { sourceSha256: digest(source) });
  const result = buildPdfHiddenDataSanitization(source, { sourceSha256: digest(source) });
  const after = inspectPdfHiddenDataInventory(result.bytes, { sourceSha256: digest(result.bytes) });
  assert.equal(before.actions > 0, true);
  assert.equal(before.embeddedFiles > 0, true);
  assert.equal(before.xmpMetadata > 0, true);
  assert.equal(after.actions, 0);
  assert.equal(after.embeddedFiles, 0);
  assert.equal(after.xmpMetadata, 0);
  assert.equal(after.hiddenAnnotations, 0);
  assert.equal(result.proof.reachablePageContentPreserved, true);
  assert.equal(result.proof.sourcePrefixPreserved, false);
  assert.deepEqual(inspectPdfHiddenDataSanitization(source, result.bytes, { sourceSha256: digest(source) }), result.proof);
  assert.deepEqual(verifyPdfHiddenDataSanitization({ sourceBytes: source, outputBytes: result.bytes, options: { sourceSha256: digest(source) }, expected: result.proof }), result.proof);
  const streamMarker = Buffer.from('stream\n\nendstream', 'latin1');
  assert.equal(result.bytes.includes(streamMarker), true);
});

test('bounded hidden-data sanitizer rejects source digest drift, encrypted/object-stream sources, and mixed-name hazards', () => {
  const source = hiddenPdf();
  assert.throws(() => buildPdfHiddenDataSanitization(source, { sourceSha256: '0'.repeat(64) }), { code: 'INVALID_PDF_HIDDEN_DATA_SANITIZER' });
  assert.throws(() => buildPdfHiddenDataSanitization(makeObjectStreamPdf()), { code: 'UNSUPPORTED_PDF_HIDDEN_DATA_SANITIZER_SOURCE' });
  assert.throws(() => buildPdfHiddenDataSanitization(hiddenPdf({ mixedNames: true })), { code: 'UNSUPPORTED_PDF_HIDDEN_DATA_SANITIZER_SOURCE' });
});

test('bounded hidden-data sanitizer rejects signed sources and tampered outputs', () => {
  const signed = pdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>',
    '<< /Type /Pages /Count 0 /Kids [] >>',
    '<< /Type /Sig /ByteRange [0 1 2 3] /Contents <00> >>',
    '<< /Type /AcroForm /Fields [3 0 R] >>',
  ]);
  assert.throws(() => buildPdfHiddenDataSanitization(signed), { code: 'UNSUPPORTED_PDF_HIDDEN_DATA_SANITIZER_SOURCE' });
  const source = hiddenPdf(); const result = buildPdfHiddenDataSanitization(source);
  const tampered = Buffer.from(result.bytes); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => inspectPdfHiddenDataSanitization(source, tampered), { code: 'INVALID_PDF_HIDDEN_DATA_SANITIZER_OUTPUT' });
});

test('bounded hidden-data sanitizer preserves benign same-named resource keys and rejects nonzero generations', () => {
  const source = pdf([
    '<< /Type /Catalog /Pages 2 0 R /Custom << /Metadata (benign) /AF (benign) >> >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] /Resources 5 0 R /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Type /XObject /A (benign) /Custom << /Metadata (nested) /AF (nested) >> >>',
  ]);
  const result = buildPdfHiddenDataSanitization(source);
  assert.match(result.bytes.toString('latin1'), /\/Custom\s+<</u);
  assert.match(result.bytes.toString('latin1'), /\/AF\s+<62656E69676E>/u);
  assert.match(result.bytes.toString('latin1'), /\/Metadata\s+<62656E69676E>/u);
  assert.match(result.bytes.toString('latin1'), /\/Metadata\s+<6E6573746564>/u);
  assert.match(result.bytes.toString('latin1'), /\/A\s+<62656E69676E>/u);
  let body = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 1 R >>\nendobj\n2 1 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n';
  const offset = Buffer.byteLength('%PDF-1.7\n', 'latin1');
  body += `xref\n0 3\n0000000000 65535 f \n${String(offset).padStart(10, '0')} 00000 n \n${String(offset + 58).padStart(10, '0')} 00001 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(body, 'latin1')}\n%%EOF\n`;
  assert.throws(() => buildPdfHiddenDataSanitization(Buffer.from(body, 'latin1')), { code: 'UNSUPPORTED_PDF_HIDDEN_DATA_SANITIZER_SOURCE' });
});
