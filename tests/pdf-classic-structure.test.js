import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLASSIC_PDF_STRUCTURE_LIMITS,
  parseClassicPdfStructure,
  resolveClassicPdfObject,
} from '../scripts/host/pdf-classic-structure.mjs';

function fixture() {
  const header = '%PDF-1.7\n';
  const catalog = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const info = '2 0 obj\n<< /Title (Old) >>\nendobj\n';
  const catalogOffset = Buffer.byteLength(header, 'latin1');
  const infoOffset = catalogOffset + Buffer.byteLength(catalog, 'latin1');
  const xrefOffset = infoOffset + Buffer.byteLength(info, 'latin1');
  const xref = `xref\n0 3\n0000000000 65535 f \n${String(catalogOffset).padStart(10, '0')} 00000 n \n${String(infoOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R /Info 2 0 R /ID [<${'11'.repeat(16)}> <${'22'.repeat(16)}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(`${header}${catalog}${info}${xref}`, 'latin1');
}

test('classic structure exposes the bounded effective graph without syntax internals', () => {
  const structure = parseClassicPdfStructure(fixture());
  assert.equal(Object.isFrozen(CLASSIC_PDF_STRUCTURE_LIMITS), true);
  assert.equal(Object.isFrozen(structure), true);
  assert.equal(structure.revisions.length, 1);
  assert.deepEqual(structure.root, { type: 'ref', object: 1, generation: 0 });
  assert.deepEqual(structure.info, { type: 'ref', object: 2, generation: 0 });
  assert.equal(structure.id[0].toString('hex'), '11'.repeat(16));
  assert.equal(resolveClassicPdfObject(structure, structure.root).value.entries.get('Type').value, 'Catalog');
});

test('classic structure maps malformed graph references to its neutral parser error', () => {
  const bytes = fixture();
  const structure = parseClassicPdfStructure(bytes);
  assert.throws(() => resolveClassicPdfObject(structure, { object: 9, generation: 0 }), {
    code: 'INVALID_CLASSIC_PDF_STRUCTURE',
  });
  assert.throws(() => parseClassicPdfStructure(Buffer.from(bytes.subarray(1))), {
    code: 'INVALID_CLASSIC_PDF_STRUCTURE',
  });
});

test('classic resolver authority ignores exposed-map and returned-value mutation', () => {
  const structure = parseClassicPdfStructure(fixture());
  const first = resolveClassicPdfObject(structure, structure.info);
  first.value.entries.get('Title').bytes[0] = 0x58;
  first.value.entries.clear();
  structure.effective.clear(); structure.objects.clear();
  const second = resolveClassicPdfObject(structure, structure.info);
  assert.equal(second.value.entries.get('Title').bytes.toString('latin1'), 'Old');
  assert.throws(() => resolveClassicPdfObject(Object.freeze({ ...structure }), structure.root), {
    code: 'INVALID_CLASSIC_PDF_STRUCTURE',
  });
});
