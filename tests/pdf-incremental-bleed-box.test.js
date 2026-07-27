import assert from 'node:assert/strict';
import test from 'node:test';
import { findFinalStartXref } from '../scripts/host/pdf-classic-syntax.mjs';
import { normalizeIncrementalBleedBox } from '../scripts/host/pdf-incremental-bleed-box-contract.mjs';
import {
  inspectIncrementalPdfBleedBox, writeIncrementalPdfBleedBox,
} from '../scripts/host/pdf-incremental-bleed-box-writer.mjs';

const request = Object.freeze({ profile: 'local-classic-incremental-bleed-box-v1', page: 1,
  rect: Object.freeze({ x: 5, y: 5, width: 90, height: 90 }) });

function fixture({ pages = '2 0 R', page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /TrimBox [10 10 90 90] /BleedBox [0 0 100 100] >>', catalog = null } = {}) {
  const bodies = new Map([
    [1, catalog ?? `<< /Type /Catalog /Pages ${pages} >>`],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'], [3, page],
  ]);
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  for (const [number, body] of bodies) {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 4\n0000000000 65535 f \n');
  for (const number of [1, 2, 3]) chunks.push(`${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function appendRepeat(source) {
  const xref = source.length + 1; const previous = findFinalStartXref(source);
  return Buffer.concat([source, Buffer.from(`\nxref\n3 1\n0000000000 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1')]);
}

test('bleed-box contract accepts exactly the bounded profile request', () => {
  assert.deepEqual(normalizeIncrementalBleedBox(request), request);
  for (const value of [
    { ...request, page: 0 }, { ...request, page: 101 }, { ...request, rect: { x: 0, y: 0, width: 0, height: 1 } },
    { ...request, rect: { x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 } },
    { ...request, rect: { x: 1_000_001, y: 0, width: 1, height: 1 } },
    { ...request, extra: true }, { ...request, profile: 'other' },
  ]) assert.throws(() => normalizeIncrementalBleedBox(value), { code: 'INVALID_INCREMENTAL_BLEED_BOX' });
});

test('writer replaces only the selected page BleedBox with one deterministic canonical revision', () => {
  const source = fixture(); const first = writeIncrementalPdfBleedBox(source, request);
  const second = writeIncrementalPdfBleedBox(source, request);
  assert.deepEqual(first.bytes, second.bytes); assert.equal(first.bytes.subarray(0, source.length).equals(source), true);
  assert.match(first.bytes.subarray(source.length).toString('latin1'), /^\n3 0 obj\n/);
  assert.match(first.bytes.subarray(source.length).toString('latin1'), /xref\n3 1\n/);
  assert.deepEqual(inspectIncrementalPdfBleedBox(source, first.bytes, request), first.proof);
  assert.equal(first.proof.onlyTargetChanged, true); assert.equal(first.proof.pageReference, '3 0 R');
});

test('writer rejects malformed page trees, actions, annotations, and page-box containment failures', () => {
  const bad = [
    fixture({ page: '<< /Type /Page /Parent 1 0 R /MediaBox [0 0 100 100] /TrimBox [10 10 90 90] /BleedBox [0 0 100 100] >>' }),
    fixture({ page: '<< /Type /Page /Parent 2 0 R /Annots [] /MediaBox [0 0 100 100] /TrimBox [10 10 90 90] /BleedBox [0 0 100 100] >>' }),
    fixture({ catalog: '<< /Type /Catalog /Pages 2 0 R /OpenAction 3 0 R >>' }),
    fixture({ catalog: '<< /Type /Catalog /Pages 2 0 R /AcroForm <<>> >>' }),
    fixture({ catalog: '<< /Type /Catalog /Pages 2 0 R /Names <<>> >>' }),
    fixture({ page: '<< /Type /Page /Parent 2 0 R /A << /S /URI >> /MediaBox [0 0 100 100] /TrimBox [10 10 90 90] /BleedBox [0 0 100 100] >>' }),
    fixture({ page: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /TrimBox [10 10 90 90] /BleedBox 4 0 R >>' }),
    fixture({ page: '<< /Type /Page /Parent 2 0 R /Metadata 4 0 R /MediaBox [0 0 100 100] /TrimBox [10 10 90 90] /BleedBox [0 0 100 100] >>' }),
    fixture({ page: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /TrimBox [10 10 90 90] /BleedBox [20 20 80 80] >>' }),
    fixture({ page: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /TrimBox [0 0 100 100] /BleedBox [0 0 100 100] >>' }),
  ];
  for (const [index, source] of bad.entries()) assert.throws(() => writeIncrementalPdfBleedBox(source, request), {
    code: 'UNSUPPORTED_INCREMENTAL_BLEED_BOX_PDF',
  }, `bad fixture ${index}`);
  assert.throws(() => writeIncrementalPdfBleedBox(fixture(), { ...request, rect: { x: 20, y: 20, width: 60, height: 60 } }), {
    code: 'UNSUPPORTED_INCREMENTAL_BLEED_BOX_PDF',
  });
  assert.throws(() => writeIncrementalPdfBleedBox(fixture(), { ...request, rect: { x: 0, y: 0, width: 100, height: 100 } }), {
    code: 'INVALID_INCREMENTAL_BLEED_BOX',
  });
});

test('independent inspection rejects source-prefix, tail, and non-target mutations', () => {
  const source = fixture(); const output = writeIncrementalPdfBleedBox(source, request).bytes;
  const prefix = Buffer.from(output); prefix[20] ^= 1;
  const tail = Buffer.concat([output, Buffer.from(' ', 'latin1')]);
  const changed = Buffer.from(output); const marker = changed.lastIndexOf(Buffer.from('/BleedBox [5 5 95 95]', 'latin1')); changed[marker + 12] = 54;
  for (const candidate of [prefix, tail, changed]) assert.throws(
    () => inspectIncrementalPdfBleedBox(source, candidate, request), { code: 'INVALID_INCREMENTAL_BLEED_BOX_OUTPUT' },
  );
});

test('writer rejects revision and aggregate xref-row limits before appending', () => {
  let revisions = fixture(); for (let index = 1; index < 32; index += 1) revisions = appendRepeat(revisions);
  assert.throws(() => writeIncrementalPdfBleedBox(revisions, request), { code: 'UNSUPPORTED_INCREMENTAL_BLEED_BOX_PDF' });
  const chunks = ['%PDF-1.7\n', '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n', '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /TrimBox [10 10 90 90] /BleedBox [0 0 100 100] >>\nendobj\n'];
  const offset = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 50000\n0000000000 65535 f \n');
  for (let index = 1; index < 50_000; index += 1) chunks.push(`${String(index < 4 ? [9, 55, 112][index - 1] : 0).padStart(10, '0')} 00000 ${index < 4 ? 'n' : 'f'} \n`);
  chunks.push(`trailer\n<< /Size 50000 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
  assert.throws(() => writeIncrementalPdfBleedBox(Buffer.from(chunks.join(''), 'latin1'), request), { code: 'UNSUPPORTED_INCREMENTAL_BLEED_BOX_PDF' });
});
