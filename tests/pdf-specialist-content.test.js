import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { PDF_SPECIALIST_CONTENT_PROFILE, inspectPdfSpecialistContent } from '../scripts/host/pdf-specialist-content-inventory.mjs';

function request(source) { return { profile: PDF_SPECIALIST_CONTENT_PROFILE, sourceSha256: createHash('sha256').update(source).digest('hex') }; }
function classicPdf(objects) {
  const chunks = [Buffer.from('%PDF-1.7\n', 'latin1')]; const offsets = [0];
  for (let index = 1; index <= Math.max(...objects.keys()); index += 1) { offsets[index] = Buffer.concat(chunks).length; chunks.push(Buffer.from(`${index} 0 obj\n${objects.get(index)}\nendobj\n`, 'latin1')); }
  const xref = Buffer.concat(chunks).length; const rows = [`xref\n0 ${offsets.length}`, '0000000000 65535 f ']; for (let index = 1; index < offsets.length; index += 1) rows.push(`${String(offsets[index]).padStart(10, '0')} 00000 n `); rows.push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); chunks.push(Buffer.from(`${rows.join('\n')}\n`, 'latin1')); return Buffer.concat(chunks);
}
test('specialist inventory is bounded, privacy-minimal, and read-only', () => {
  const source = makeMultiPagePdf(['one', 'two']); const result = inspectPdfSpecialistContent(source, request(source));
  assert.equal(result.pageCount, 2); assert.equal(result.embeddedFiles.count, 0); assert.equal(result.evidence.payloadBytesReturned, false); assert.equal(result.evidence.namesReturned, false); assert.equal(result.evidence.textReturned, false); assert.equal(result.evidence.pathsReturned, false); assert.equal(result.profile, PDF_SPECIALIST_CONTENT_PROFILE); assert.equal(Object.isFrozen(result), true); assert.equal(source.includes(Buffer.from('printer', 'latin1')), false);
});

test('specialist inventory reports representative portfolio, attachment, annotation, geospatial, AF, and rendition evidence without payload identifiers', () => {
  const embedded = '<< /Type /EmbeddedFile /Length 4 >>\nstream\nDATA\nendstream';
  const source = classicPdf(new Map([
    [6, 'null'], [7, 'null'], [8, 'null'], [11, 'null'],
    [1, '<< /Type /Catalog /Pages 2 0 R /Collection 9 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Annots 12 0 R /AF [13 0 R] /VP 14 0 R /Contents 5 0 R >>'],
    [4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'], [5, '<< /Length 0 >>\nstream\n\nendstream'],
    [9, '<< /Type /Collection /Schema 20 0 R /Sort << /S /A >> /View /T >>'], [10, '<< /Names [] >>'], [12, '[15 0 R 16 0 R]'],
    [13, '<< /Type /Filespec /F (secret.txt) /AFRelationship /Data /EF << /F 19 0 R >> >>'], [14, '<< /Type /Viewport /Measure 21 0 R >>'],
    [15, '<< /Type /Annot /Subtype /RichMedia /RichMediaContent 17 0 R /A << /S /Rendition /R 18 0 R >> >>'], [16, '<< /Type /Annot /Subtype /FileAttachment /FS 13 0 R >>'],
    [17, '<< /Type /RichMediaContent >>'], [18, '<< /Type /Rendition /S /MR /C 19 0 R >>'], [19, embedded],
    [20, '<< /A << /Type /CollectionField /E true >> /B << /Type /CollectionField /E false >> >>'], [21, '<< /Type /Measure /Subtype /RL /U /m /LGIDict 22 0 R >>'], [22, '<< /Type /LGIDict /Version 1 >>'],
  ]));
  const result = inspectPdfSpecialistContent(source, request(source));
  assert.equal(result.collection.present, true); assert.equal(result.collection.schemaFieldCount, 2);
  assert.equal(result.collection.sortFlags.present, true); assert.equal(result.collection.viewFlags.present, true);
  assert.equal(result.embeddedFiles.count, 1); assert.equal(result.embeddedFiles.aggregateBytes, 4); assert.equal(result.embeddedFiles.records[0].page, 1);
  assert.equal(result.embeddedFiles.records[0].sha256, createHash('sha256').update('DATA').digest('hex'));
  assert.equal(result.annotations.subtypeCounts.RichMedia, 1); assert.equal(result.annotations.subtypeCounts.FileAttachment, 1);
  assert.deepEqual(result.annotations.loci.map(({ page, subtype }) => ({ page, subtype })), [{ page: 1, subtype: 'RichMedia' }, { page: 1, subtype: 'FileAttachment' }]);
  assert.equal(result.annotations.activationCount, 1); assert.equal(result.renditionMedia.mediaActionCount, 1); assert.equal(result.renditionMedia.renditionCount, 1);
  assert.equal(result.geospatial.measureCount, 1); assert.equal(result.geospatial.vpCount, 1); assert.equal(result.associatedFiles.count, 1);
  assert.equal(result.evidence.objectReferencesReturned, false); assert.equal(JSON.stringify(result).includes('secret.txt'), false); assert.equal(JSON.stringify(result).includes('DATA'), false);
  assert.equal(result.evidence.aliasCount > 0, true);
});
test('specialist inventory rejects cycles instead of treating them as aliases', () => {
  const source = classicPdf(new Map([[1, '<< /Type /Catalog /Pages 2 0 R /Collection 9 0 R >>'], [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'], [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>'], [9, '<< /Type /Collection /Schema 9 0 R >>']]));
  assert.throws(() => inspectPdfSpecialistContent(source, request(source)), { code: 'UNSUPPORTED_PDF_SPECIALIST_CONTENT' });
});
test('specialist inventory rejects malformed requests and source digest drift', () => {
  const source = makeMultiPagePdf(['one']); const valid = request(source);
  assert.throws(() => inspectPdfSpecialistContent(source, { ...valid, sourceSha256: '0'.repeat(64) }), { code: 'INVALID_PDF_SPECIALIST_CONTENT' });
  assert.throws(() => inspectPdfSpecialistContent(source, { ...valid, extra: true }), { code: 'INVALID_PDF_SPECIALIST_CONTENT' });
});
