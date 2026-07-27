import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectPdfAcroFormSignatureField, preparePdfAcroFormSignatureField, PDF_ACROFORM_SIGNATURE_FIELD_PROFILE } from '../scripts/host/pdf-acroform-signature-field-writer.mjs';

function fixture(extra = '') { const bodies = new Map([[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>'], [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>'], [4, '<< /Length 0 >>\nstream\n\nendstream'], [5, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 6 0 R >>'], [6, '<< /Length 0 >>\nstream\n\nendstream']]);
const chunks = ['%PDF-1.7\n'];
const offsets = new Map();
for (const [number, body] of bodies) { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
} const xref = Buffer.byteLength(chunks.join(''), 'latin1');
chunks.push(`xref\n0 7\n0000000000 65535 f \n${[1, 2, 3, 4, 5, 6].map((number) => `${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R${extra} >>\nstartxref\n${xref}\n%%EOF\n`);
return Buffer.from(chunks.join(''), 'latin1');
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex');
}
function request(source, extra = {}) { return { profile: PDF_ACROFORM_SIGNATURE_FIELD_PROFILE, sourceSha256: digest(source), page: 1, fieldName: 'Sign.Here', rect: { x: 72, y: 700, width: 180, height: 24 }, ...extra };
}

test('signature-field writer emits an empty unsigned terminal widget without appearance or value', () => { const source = fixture();
const value = request(source);
const prepared = preparePdfAcroFormSignatureField(source, value);
assert.equal(prepared.proof.emptyUnsigned, true);
assert.equal(prepared.proof.objectCount, 2);
const proof = inspectPdfAcroFormSignatureField(source, prepared.bytes, value);
assert.deepEqual(proof.references, prepared.proof.references);
});

test('installed Poppler tools recognize the prepared PDF and report no signed value', (t) => {
  const source = fixture();
  const prepared = preparePdfAcroFormSignatureField(source, request(source));
  const root = mkdtempSync(join(tmpdir(), 'pdf-acroform-signature-field-poppler-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'prepared.pdf');
  writeFileSync(path, prepared.bytes);
  const info = spawnSync('pdfinfo', [path], { encoding: 'utf8' });
  assert.equal(info.status, 0, info.stderr);
  assert.match(info.stdout, /Pages:\s+2/);
  assert.match(info.stdout, /Form:\s+AcroForm/);
  const signatures = spawnSync('pdfsig', [path], { encoding: 'utf8' });
  assert.equal(signatures.status, 0, signatures.stderr);
  assert.match(`${signatures.stdout}\n${signatures.stderr}`, /not signed|no signatures|0 signatures/i);
});
test('signature-field writer rejects hostile requests, tampering, and active or existing form sources', () => { const source = fixture();
assert.throws(() => preparePdfAcroFormSignatureField(source, request(source, { fieldName: 'e\u0301' })), { code: 'INVALID_PDF_ACROFORM_SIGNATURE_FIELD' });
assert.throws(() => preparePdfAcroFormSignatureField(source, request(source, { rect: { x: 600, y: 780, width: 24, height: 24 } })), { code: 'INVALID_PDF_ACROFORM_SIGNATURE_FIELD' });
const prepared = preparePdfAcroFormSignatureField(source, request(source));
const tampered = Buffer.from(prepared.bytes);
tampered[tampered.length - 20] ^= 1;
assert.throws(() => inspectPdfAcroFormSignatureField(source, tampered, request(source)), { code: 'INVALID_PDF_ACROFORM_SIGNATURE_FIELD_OUTPUT' });
for (const marker of ['/AcroForm 7 0 R', '/Annots [7 0 R]', '/OpenAction 7 0 R', '/ByteRange [0 1 2 3]', '/Encrypt 7 0 R']) { const changed = Buffer.from(source.toString('latin1').replace('<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Catalog /Pages 2 0 R ${marker} >>`), 'latin1');
assert.throws(() => preparePdfAcroFormSignatureField(changed, request(changed)), { code: 'UNSUPPORTED_PDF_ACROFORM_SIGNATURE_FIELD_SOURCE' });
} });
