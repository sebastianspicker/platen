import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFullPageRedaction, writeFullPageRedactionBatch, FULL_PAGE_REDACTION_BATCH_PROFILE, FULL_PAGE_REDACTION_PROFILE } from '../scripts/host/pdf-full-page-redaction-writer.mjs';
import { parsePdfStructure, resolvePdfObject } from '../scripts/host/pdf-classic-structure.mjs';

function streamObject(payload) {
  const bytes = Buffer.from(payload, 'latin1');
  return `<< /Length ${bytes.length + 1} >>\nstream\n${payload}\nendstream`;
}

function conformingFixture({ sharedResource = false } = {}) {
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 2 /Kids [3 0 R 6 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'],
    [4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [5, streamObject('BT /F1 12 Tf 10 80 Td (secret) Tj ET')],
    [6, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources << /Font << /F1 ${sharedResource ? 4 : 8} 0 R >> >> /Contents 7 0 R >>`],
    [7, streamObject('BT /F1 12 Tf 10 80 Td (survivor) Tj ET')],
    [8, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ]);
  const chunks = ['%PDF-1.7\n'];
  const offsets = new Map();
  for (const [number, body] of bodies) {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  }
  const size = Math.max(...bodies.keys()) + 1;
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let index = 1; index < size; index += 1) chunks.push(`${String(offsets.get(index)).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

const source = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');
const digest = createHash('sha256').update(source).digest('hex');

test('full-page redaction contract rejects malformed requests and unsupported sources', () => {
  assert.throws(() => writeFullPageRedaction(source, { profile: FULL_PAGE_REDACTION_PROFILE, sourceSha256: digest, page: 0 }), { code: 'INVALID_FULL_PAGE_REDACTION' });
  assert.throws(() => writeFullPageRedaction(source, { profile: FULL_PAGE_REDACTION_PROFILE, sourceSha256: digest, page: 1 }), { code: 'UNSUPPORTED_FULL_PAGE_REDACTION' });
});

test('full-page redaction writes a closed compact rewrite and removes target-bound objects', () => {
  const input = conformingFixture();
  const sourceSha256 = createHash('sha256').update(input).digest('hex');
  const result = writeFullPageRedaction(input, { profile: FULL_PAGE_REDACTION_PROFILE, sourceSha256, page: 1 });
  assert.equal(result.proof.closedRevision, true);
  assert.equal(result.proof.directEmptyResources, true);
  assert.equal(result.proof.supersededReferencesAbsent, true);

  const output = parsePdfStructure(result.bytes);
  assert.equal(output.revisions.length, 1);
  assert.equal(output.revisions[0].trailer.has('Prev'), false);
  const target = resolvePdfObject(output, { type: 'ref', object: 3, generation: 0 });
  const targetEntries = target.value.entries;
  assert.deepEqual([...targetEntries.get('Resources').entries], []);
  const targetStream = resolvePdfObject(output, targetEntries.get('Contents'));
  assert.equal(targetStream.stream, true);
  const targetBytes = result.bytes.subarray(targetStream.streamStart, targetStream.streamStart + targetStream.streamLength);
  assert.equal(targetBytes.toString('latin1'), 'q 0 g 0 0 100 100 re f Q\n');
  assert.equal(result.bytes.includes(Buffer.from('BT /F1 12 Tf 10 80 Td (secret) Tj ET', 'latin1')), false);
  for (const reference of [{ type: 'ref', object: 4, generation: 0 }, { type: 'ref', object: 5, generation: 0 }]) {
    assert.equal(output.effective.has(reference.object), false);
    assert.throws(() => resolvePdfObject(output, reference));
  }

  const survivor = resolvePdfObject(output, { type: 'ref', object: 6, generation: 0 });
  assert.equal(survivor.value.entries.get('Contents').object, 7);
  const survivorStream = resolvePdfObject(output, { type: 'ref', object: 7, generation: 0 });
  assert.equal(result.bytes.subarray(survivorStream.streamStart, survivorStream.streamStart + survivorStream.streamLength).toString('latin1'), 'BT /F1 12 Tf 10 80 Td (survivor) Tj ET\n');
});

test('full-page redaction rejects target resources shared by a non-target page', () => {
  const input = conformingFixture({ sharedResource: true });
  const sourceSha256 = createHash('sha256').update(input).digest('hex');
  assert.throws(() => writeFullPageRedaction(input, { profile: FULL_PAGE_REDACTION_PROFILE, sourceSha256, page: 1 }), { code: 'UNSUPPORTED_FULL_PAGE_REDACTION' });
});

test('full-page redaction batch atomically closes multiple targets and preserves no superseded objects', () => {
  const input = conformingFixture(); const sourceSha256 = createHash('sha256').update(input).digest('hex');
  const result = writeFullPageRedactionBatch(input, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256, pages: [1, 2] });
  assert.deepEqual(result.proof.pages, [1, 2]); assert.equal(result.proof.closedRevision, true); assert.equal(result.proof.priorRevisionsAbsent, true); assert.equal(result.proof.supersededReferencesAbsent, true);
  const output = parsePdfStructure(result.bytes); assert.equal(output.revisions.length, 1); assert.equal(output.revisions[0].trailer.has('Prev'), false);
  for (const pageReference of [{ object: 3, generation: 0 }, { object: 6, generation: 0 }]) { const page = resolvePdfObject(output, { type: 'ref', ...pageReference }); const stream = resolvePdfObject(output, page.value.entries.get('Contents')); const bytes = result.bytes.subarray(stream.streamStart, stream.streamStart + stream.streamLength); assert.match(bytes.toString('latin1'), /^q 0 g 0 0 100 100 re f Q\n$/u); }
  for (const object of [4, 5, 7, 8]) assert.equal(output.effective.has(object), false);
});

test('full-page redaction batch rejects duplicates, unsorted pages, and out-of-range pages', () => {
  const input = conformingFixture(); const sourceSha256 = createHash('sha256').update(input).digest('hex'); const base = { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256 };
  for (const pages of [[1, 1], [2, 1], [3], []]) assert.throws(() => writeFullPageRedactionBatch(input, { ...base, pages }), { code: pages[0] === 3 ? 'UNSUPPORTED_FULL_PAGE_REDACTION' : pages.length === 0 ? 'INVALID_FULL_PAGE_REDACTION_BATCH' : 'INVALID_FULL_PAGE_REDACTION_BATCH' });
});

test('full-page redaction batch rejects resources shared by two target pages', () => {
  const input = conformingFixture({ sharedResource: true }); const sourceSha256 = createHash('sha256').update(input).digest('hex');
  assert.throws(() => writeFullPageRedactionBatch(input, { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256, pages: [1, 2] }), { code: 'UNSUPPORTED_FULL_PAGE_REDACTION' });
});
