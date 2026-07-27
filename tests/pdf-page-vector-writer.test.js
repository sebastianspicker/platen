import assert from 'node:assert/strict';
import test from 'node:test';
import { INCREMENTAL_PAGE_VECTOR_PROFILE } from '../scripts/host/pdf-page-vector-contract.mjs';
import {
  inspectIncrementalPdfPageVector,
  writeIncrementalPdfPageVector,
} from '../scripts/host/pdf-page-vector-writer.mjs';

const request = Object.freeze({
  profile: INCREMENTAL_PAGE_VECTOR_PROFILE,
  page: 1,
  rect: Object.freeze({
    x: 10,
    y: 10,
    width: 50,
    height: 50,
  }),
});

function fixture({ page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] >>',
  extra = [] } = {}) {
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, page],
    ...extra,
  ]);
  const chunks = ['%PDF-1.7\n'];
  const offsets = new Map();
  for (const [number, body] of bodies) {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  }
  const size = Math.max(...offsets.keys()) + 1;
  const xrefOffset = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let index = 1; index < size; index += 1) {
    chunks.push(`${String(offsets.get(index)).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

test('writes and inspects an incremental page-vector when the source is strict simple one-page input', () => {
  const source = fixture();
  const result = writeIncrementalPdfPageVector(source, request);
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(result.bytes.includes(Buffer.from('q 0 0 0 RG 1 w 10 10 50 50 re S Q', 'latin1')), true);
  assert.deepEqual(inspectIncrementalPdfPageVector(source, result.bytes, request), result.proof);
});

test('rejects pre-existing /Contents and unsupported active structure', () => {
  const withContents = fixture({
    page: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Contents 4 0 R >>',
    extra: [[4, '<< /Length 4 >>\nstream\nabc\nendstream']],
  });
  assert.throws(() => writeIncrementalPdfPageVector(withContents, request), {
    code: 'UNSUPPORTED_INCREMENTAL_PAGE_VECTOR_PDF',
  });

  const withContentsArray = fixture({
    page: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Contents [4 0 R] >>',
    extra: [[4, '<< /Length 4 >>\nstream\nabc\nendstream']],
  });
  assert.throws(() => writeIncrementalPdfPageVector(withContentsArray, request), {
    code: 'UNSUPPORTED_INCREMENTAL_PAGE_VECTOR_PDF',
  });

  const unsafeAction = fixture({
    page: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources << /X 4 0 R >> >>',
    extra: [[4, '<< /Type /Action /S /JavaScript >>']],
  });
  assert.throws(() => writeIncrementalPdfPageVector(unsafeAction, request), {
    code: 'UNSUPPORTED_INCREMENTAL_PAGE_VECTOR_PDF',
  });
});
