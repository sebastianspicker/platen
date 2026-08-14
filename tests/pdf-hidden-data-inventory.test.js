import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectPdfHiddenDataInventory } from '../scripts/host/pdf-hidden-data-inventory.mjs';
import { makeObjectStreamPdf } from './support/pdf-xref-stream-fixture.js';

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeClassicPdf(objects, { infoReference = null } = {}) {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R`;
  if (infoReference !== null) body += ` /Info ${infoReference} 0 R`;
  body += ` >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function encryptedPdf() {
  const chunks = ['%PDF-1.7\n'];
  const offsets = [];
  const addObject = (number, body) => {
    const offset = Buffer.byteLength(chunks.join(''), 'latin1');
    offsets.push(offset);
    void number;
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  };
  addObject(1, '<< /Type /Catalog >>');
  addObject(2, `<< /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 /O <${'01'.repeat(32)}> /U <${'02'.repeat(32)}> /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /EncryptMetadata true >>`);
  const xrefOffset = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 3\n');
  chunks.push('0000000000 65535 f \n');
  for (const offset of offsets) {
    chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(
    `trailer\n<< /Size 3 /Root 1 0 R /Encrypt 2 0 R /ID [<${'11'.repeat(16)}> <${'22'.repeat(16)}>] >>\n`,
  );
  chunks.push(`startxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function makeRevisionedPdfWithPriorResidue() {
  let body = '%PDF-1.7\n';
  const catalogOffset = Buffer.byteLength(body, 'latin1');
  const pagesOffset = catalogOffset + Buffer.byteLength('1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1');
  const targetOffset = pagesOffset + Buffer.byteLength('2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n', 'latin1');
  body += '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  body += '2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n';
  body += '3 0 obj\n<< /Kind /Target >>\nendobj\n';

  const oldestXrefOffset = Buffer.byteLength(body, 'latin1');
  body += 'xref\n0 4\n0000000000 65535 f \n';
  body += `${String(catalogOffset).padStart(10, '0')} 00000 n \n`;
  body += `${String(pagesOffset).padStart(10, '0')} 00000 n \n`;
  body += `${String(targetOffset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size 4 /Root 1 0 R >>\n`;
  body += `startxref\n${oldestXrefOffset}\n%%EOF\n`;

  const middleXrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 4\n0000000000 65535 f \n`;
  body += `${String(catalogOffset).padStart(10, '0')} 00000 n \n`;
  body += `${String(pagesOffset).padStart(10, '0')} 00000 n \n`;
  body += `${String(targetOffset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size 4 /Root 1 0 R /Prev ${oldestXrefOffset} >>\n`;
  body += `startxref\n${middleXrefOffset}\n%%EOF\n`;

  const newestXrefOffset = Buffer.byteLength(body, 'latin1');
  body += 'xref\n0 3\n0000000000 65535 f \n';
  body += `${String(catalogOffset).padStart(10, '0')} 00000 n \n`;
  body += `${String(pagesOffset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size 4 /Root 1 0 R /Prev ${middleXrefOffset} >>\n`;
  body += `startxref\n${newestXrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('hidden-data inventory classifies hidden-content dictionaries and summarizes reachable objects', () => {
  const source = makeClassicPdf([
    '<< /Type /Catalog /OpenAction 3 0 R /Pages 2 0 R /Names << /EmbeddedFiles 5 0 R >> /StructTreeRoot 12 0 R >>',
    '<< /Type /Pages /Count 0 /Kids [] >>',
    '<< /Type /Action /S /JavaScript /JS (noop) >>',
    '<< /Type /Action /S /URI /URI (https://example.invalid) >>',
    '<< /Names [ (note.txt) 6 0 R ] /EmbeddedFiles 6 0 R >>',
    '<< /Type /Filespec /F (note.txt) /EF << /F 7 0 R >> >>',
    '<< /Type /EmbeddedFile >>',
    '<< /Type /AcroForm /Fields [9 0 R] /XFA 10 0 R >>',
    '<< /FT /Sig /ByteRange [0 1 2 3] >>',
    '<< /Type /XFA /Filter /FlateDecode /DecodeParms << >> >>',
    '<< /Type /OCG >>',
    '<< /Type /StructTreeRoot /K [13 0 R] >>',
    '<< /MarkInfo true >>',
    '<< /Type /Annot /F 33 >>',
    '<< /Type /Page /Thumb 16 0 R /MediaBox [0 0 1 1] >>',
    '<< /PieceInfo << /My (Info) >> >>',
    '<< /SpiderInfo << /My (Info) >> >>',
    '<< /Private << /My (Info) >> >>',
    '<< /Type /XObject /Subtype /Image /Alternates [9 0 R] >>',
    '<< /Type /XObject /Subtype /Image /OPI << /Type /ImageData >> >>',
    '<< /Type /Metadata /Subtype /XML /Length 0 >>',
    '<< /Title (Hidden inventory source) >>',
  ], { infoReference: 22 });
  const result = inspectPdfHiddenDataInventory(source, { sourceSha256: checksum(source) });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.sourceBytes, source.length);
  assert.equal(result.sourceSha256, checksum(source));
  assert.equal(result.schema, 'pdf-hidden-data-inventory-v1');
  assert.equal(result.version, 1);
  assert.deepEqual(result, {
    sourceBytes: source.length,
    sourceSha256: checksum(source),
    schema: 'pdf-hidden-data-inventory-v1',
    version: 1,
    trailerInfo: 1,
    xmpMetadata: 1,
    embeddedFiles: 3,
    actions: 3,
    javascriptActions: 1,
    actionObjects: 2,
    acroForm: 1,
    xfa: 2,
    signatureFields: 1,
    byteRanges: 1,
    optionalContent: 1,
    structTree: 2,
    marked: 1,
    hiddenAnnotations: 1,
    pageThumbnails: 1,
    pieceInfo: 1,
    spiderInfo: 1,
    privateData: 1,
    alternateImages: 1,
    opi: 1,
    revisionCount: 1,
    xrefFlavor: 'classic',
    effectiveObjectCount: 22,
    reachableObjectCount: 9,
    unreachableObjectCount: 13,
    priorRevisionResidue: { present: false, objectCount: 0 },
    orphanResidue: { present: true, objectCount: 13 },
  });
});

test('hidden-data inventory validates source bytes and sourceSha256 inputs', () => {
  const source = makeClassicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 0 /Kids [] >>',
  ]);
  const goodDigest = checksum(source);
  const sourceObject = Object.freeze({ sourceSha256: goodDigest });
  assert.equal(inspectPdfHiddenDataInventory(source, sourceObject).sourceBytes, source.length);
  assert.throws(() => inspectPdfHiddenDataInventory(source, { sourceSha256: 'BAD' }), {
    code: 'INVALID_PDF_HIDDEN_DATA_INVENTORY',
  });
  const accessor = Object.create(null);
  Object.defineProperty(accessor, 'sourceSha256', {
    get() { return goodDigest; },
    enumerable: true,
    configurable: true,
  });
  assert.throws(() => inspectPdfHiddenDataInventory(source, accessor), { code: 'INVALID_PDF_HIDDEN_DATA_INVENTORY' });
  assert.throws(() => inspectPdfHiddenDataInventory(source, { sourceSha256: goodDigest, extra: 1 }), {
    code: 'INVALID_PDF_HIDDEN_DATA_INVENTORY',
  });
  assert.equal(inspectPdfHiddenDataInventory(source, sourceObject).sourceBytes, source.length);
  const mutated = Buffer.from(source.subarray(0));
  mutated[0] = 0x58;
  assert.throws(() => inspectPdfHiddenDataInventory(mutated, { sourceSha256: checksum(source) }), {
    code: 'INVALID_PDF_HIDDEN_DATA_INVENTORY',
  });
  const shared = new SharedArrayBuffer(source.length);
  const sharedBytes = Buffer.from(shared);
  source.copy(sharedBytes);
  assert.throws(() => inspectPdfHiddenDataInventory(sharedBytes, { sourceSha256: checksum(source) }), {
    code: 'INVALID_PDF_HIDDEN_DATA_INVENTORY',
  });
});

test('hidden-data inventory rejects encrypted PDFs and object-stream sources', () => {
  assert.throws(() => inspectPdfHiddenDataInventory(encryptedPdf()), {
    code: 'INVALID_PDF_HIDDEN_DATA_INVENTORY',
  });
  assert.throws(() => inspectPdfHiddenDataInventory(makeObjectStreamPdf()), {
    code: 'INVALID_PDF_HIDDEN_DATA_INVENTORY',
  });
});

test('hidden-data inventory ignores unknown /S action dictionaries for action totals', () => {
  const source = makeClassicPdf([
    '<< /Type /Catalog /OpenAction 2 0 R >>',
    '<< /Type /Pages /Count 0 /Kids [] >>',
    '<< /Type /Action /S /JavaScript /JS (noop) >>',
    '<< /Type /XObject /S /D /Length 0 >>',
  ]);
  const result = inspectPdfHiddenDataInventory(source);
  assert.equal(result.actions, 2);
  assert.equal(result.actionObjects, 1);
  assert.equal(result.javascriptActions, 1);
  assert.equal(result.reachableObjectCount, 2);
  assert.equal(result.unreachableObjectCount, 2);
  assert.deepEqual(result.orphanResidue, { present: true, objectCount: 2 });
});

test('hidden-data inventory reports revisioned prior residue and orphan residue', () => {
  const source = makeRevisionedPdfWithPriorResidue();
  const result = inspectPdfHiddenDataInventory(source);
  assert.deepEqual(result.priorRevisionResidue, {
    present: true,
    objectCount: 1,
  });
  assert.deepEqual(result.orphanResidue, {
    present: true,
    objectCount: 2,
  });
  assert.equal(result.revisionCount, 3);
  assert.equal(result.reachableObjectCount, 1);
  assert.equal(result.unreachableObjectCount, 2);
});
