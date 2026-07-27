import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INCREMENTAL_PAGE_TRANSITION_PROFILE,
  normalizeIncrementalPageTransition,
} from '../scripts/host/pdf-incremental-page-transition-contract.mjs';
import {
  inspectIncrementalPdfPageTransition,
  writeIncrementalPdfPageTransition,
} from '../scripts/host/pdf-incremental-page-transition-writer.mjs';

const request = Object.freeze({
  profile: INCREMENTAL_PAGE_TRANSITION_PROFILE,
  pages: Object.freeze([1, 3]),
  transition: 'Dissolve',
  duration: 1.5,
});

function fixture({ incremental = false, encrypted = false } = {}) {
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 8 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Contents 5 0 R /Resources << /Font 6 0 R >> /Annots [7 0 R] >>'],
    [4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Contents 5 0 R >>'],
    [5, '<< /Length 3 >>\nstream\nabc\nendstream'],
    [6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [7, '<< /Type /Annot /Subtype /Text /Rect [1 1 10 10] /Contents (note) >>'],
    [8, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Dur 2 >>'],
  ]);
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  for (const [number, body] of bodies) { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); const size = 9;
  chunks.push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let index = 1; index < size; index += 1) chunks.push(`${String(offsets.get(index)).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${size} /Root 1 0 R${encrypted ? ' /Encrypt 9 0 R' : ''} >>\nstartxref\n${xref}\n%%EOF\n`);
  let source = Buffer.from(chunks.join(''), 'latin1');
  if (incremental) {
    const appendStart = source.length;
    source = Buffer.concat([source, Buffer.from(`\n4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] >>\nendobj\nxref\n4 1\n${String(appendStart).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size} /Root 1 0 R /Prev ${xref} >>\nstartxref\n${appendStart}\n%%EOF\n`, 'latin1')]);
  }
  return source;
}

test('normalizes a strict Dissolve transition request and rejects ambiguous pages', () => {
  assert.deepEqual(normalizeIncrementalPageTransition(request), request);
  assert.throws(() => normalizeIncrementalPageTransition({ ...request, pages: [1, 1] }), { code: 'INVALID_INCREMENTAL_PAGE_TRANSITION' });
  assert.throws(() => normalizeIncrementalPageTransition({ ...request, pages: [2, 1] }), { code: 'INVALID_INCREMENTAL_PAGE_TRANSITION' });
  assert.throws(() => normalizeIncrementalPageTransition({ ...request, duration: 0.0001 }), { code: 'INVALID_INCREMENTAL_PAGE_TRANSITION' });
});

test('appends selected page transitions while preserving page topology and passive page content', () => {
  const source = fixture();
  const result = writeIncrementalPdfPageTransition(source, request);
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(result.bytes.includes(Buffer.from('/S /Dissolve', 'latin1')), true);
  assert.equal(result.proof.pages.length, 2);
  assert.deepEqual(inspectIncrementalPdfPageTransition(source, result.bytes, request), result.proof);
});

test('rejects malformed, encrypted, incremental, and compressed-object inputs', () => {
  assert.throws(() => writeIncrementalPdfPageTransition(Buffer.from('%PDF-1.7\nmalformed', 'latin1'), request), { code: 'UNSUPPORTED_INCREMENTAL_PAGE_TRANSITION_PDF' });
  assert.throws(() => writeIncrementalPdfPageTransition(fixture({ encrypted: true }), request), { code: 'UNSUPPORTED_INCREMENTAL_PAGE_TRANSITION_PDF' });
  assert.throws(() => writeIncrementalPdfPageTransition(fixture({ incremental: true }), request), { code: 'UNSUPPORTED_INCREMENTAL_PAGE_TRANSITION_PDF' });
});

test('raw reinspection rejects output tampering and wrong request', () => {
  const source = fixture(); const result = writeIncrementalPdfPageTransition(source, request);
  const tampered = Buffer.from(result.bytes); tampered[tampered.length - 12] ^= 1;
  assert.throws(() => inspectIncrementalPdfPageTransition(source, tampered, request), { code: 'INVALID_INCREMENTAL_PAGE_TRANSITION_OUTPUT' });
  assert.throws(() => inspectIncrementalPdfPageTransition(source, result.bytes, { ...request, duration: 2 }), { code: 'INVALID_INCREMENTAL_PAGE_TRANSITION_OUTPUT' });
});
