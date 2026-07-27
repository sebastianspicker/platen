import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { parsePdfStructure, resolvePdfObject } from '../scripts/host/pdf-classic-structure.mjs';
import { pdfDictionary, pdfReference } from '../scripts/host/pdf-classic-syntax.mjs';
import { writePdfLayerDefaults, inspectPdfLayerDefaults } from '../scripts/host/pdf-layer-defaults-writer.mjs';
import { PDF_LAYER_DEFAULTS_PROFILE } from '../scripts/host/pdf-layer-defaults-contract.mjs';

function fixture({ dExtra = '', catalogExtra = '', encrypted = false } = {}) {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  const object = (number, body, stream = null) => {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\n`);
    if (stream !== null) chunks.push(`stream\n${stream}endstream\n`);
    chunks.push('endobj\n');
  };
  object(1, `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R 8 0 R] /D << /BaseState /ON${dExtra} >> >>${catalogExtra} >>`);
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /CropBox [0 0 300 400] /Resources << /Properties << /L1 7 0 R /L2 8 0 R >> >> /Contents 5 0 R >>');
  object(5, '<< /Length 4 >>', 'q\nQ\n');
  if (encrypted) object(6, `<< /Filter /Standard /V 1 /R 2 /O <${'11'.repeat(32)}> /U <${'22'.repeat(32)}> /P -4 >>`);
  object(7, '<< /Type /OCG /Name (Layer one) /Intent /View >>');
  object(8, '<< /Type /OCG /Name (Layer two) /Intent /View >>');
  const body = chunks.join(''); const xrefOffset = Buffer.byteLength(body, 'latin1');
  let xref = 'xref\n0 9\n0000000000 65535 f \n';
  for (let number = 1; number < 9; number += 1) {
    const offset = offsets.get(number);
    xref += offset === undefined ? '0000000000 00000 f \n' : `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  return Buffer.from(`${body}${xref}trailer\n<< /Size 9 /Root 1 0 R${encrypted ? ' /Encrypt 6 0 R' : ''} >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
}

function request(source, changes) {
  return { profile: PDF_LAYER_DEFAULTS_PROFILE, sourceSha256: createHash('sha256').update(source).digest('hex'), changes };
}

function defaults(bytes) {
  const structure = parsePdfStructure(bytes); const catalog = pdfDictionary(resolvePdfObject(structure, structure.root).value);
  const properties = pdfDictionary(catalog.get('OCProperties')); const d = pdfDictionary(properties.get('D'));
  return { structure, d };
}

test('layer defaults toggles ordered groups and preserves source content', () => {
  const source = fixture(); const result = writePdfLayerDefaults(source, request(source, [{ groupIndex: 1, visible: false }]));
  assert.equal(result.proof.sourcePrefixPreserved, true); assert.equal(result.proof.onlyCatalogChanged, true);
  const { d } = defaults(result.bytes);
  assert.deepEqual(d.get('ON').values, [{ type: 'ref', object: 7, generation: 0 }]);
  assert.deepEqual(d.get('OFF').values, [{ type: 'ref', object: 8, generation: 0 }]);
  const before = defaults(source).structure; const after = defaults(result.bytes).structure;
  const beforePage = resolvePdfObject(before, { type: 'ref', object: 3, generation: 0 }); const afterPage = resolvePdfObject(after, { type: 'ref', object: 3, generation: 0 });
  assert.deepEqual(afterPage.value.entries.get('Contents'), beforePage.value.entries.get('Contents'));
  const beforeContent = resolvePdfObject(before, pdfReference(beforePage.value.entries.get('Contents')));
  const afterContent = resolvePdfObject(after, pdfReference(afterPage.value.entries.get('Contents')));
  assert.equal(result.bytes.subarray(afterContent.streamStart, afterContent.streamStart + afterContent.streamLength).toString(), source.subarray(beforeContent.streamStart, beforeContent.streamStart + beforeContent.streamLength).toString());
  const inspected = inspectPdfLayerDefaults(source, result.bytes, request(source, [{ groupIndex: 1, visible: false }]));
  assert.deepEqual(inspected.visible, [true, false]);
});

test('layer defaults rejects digest tampering, output tampering, and malformed or hazardous sources', () => {
  const source = fixture(); const valid = request(source, []);
  assert.throws(() => writePdfLayerDefaults(source, { ...valid, sourceSha256: '0'.repeat(64) }), { code: 'INVALID_PDF_LAYER_DEFAULTS' });
  const output = writePdfLayerDefaults(source, request(source, [{ groupIndex: 0, visible: false }])).bytes;
  const tampered = Buffer.from(output); tampered[tampered.length - 10] ^= 1;
  assert.throws(() => inspectPdfLayerDefaults(source, tampered, request(source, [{ groupIndex: 0, visible: false }])), { code: 'INVALID_PDF_LAYER_DEFAULTS_OUTPUT' });
  const malformed = fixture({ dExtra: ' /OFF [7 0 R 7 0 R]' });
  assert.throws(() => writePdfLayerDefaults(malformed, request(malformed, [])), { code: 'UNSUPPORTED_PDF_LAYER_DEFAULTS_PDF' });
  const hazardous = fixture({ catalogExtra: ' /AcroForm 7 0 R' });
  assert.throws(() => writePdfLayerDefaults(hazardous, request(hazardous, [])), { code: 'UNSUPPORTED_PDF_LAYER_DEFAULTS_PDF' });
  const encrypted = fixture({ encrypted: true });
  assert.throws(() => writePdfLayerDefaults(encrypted, request(encrypted, [])), { code: 'UNSUPPORTED_PDF_LAYER_DEFAULTS_PDF' });
  assert.throws(() => inspectPdfLayerDefaults(encrypted, encrypted, request(encrypted, [])), { code: 'UNSUPPORTED_PDF_LAYER_DEFAULTS_PDF' });
});
