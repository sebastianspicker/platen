import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseClassicPdfStructure,
  parsePdfStructure,
  resolveClassicPdfObject,
  resolvePdfObject,
} from '../scripts/host/pdf-classic-structure.mjs';
import { buildPdfCompactRewrite, verifyPdfCompactRewrite } from '../scripts/host/pdf-compact-rewrite.mjs';
import { makeIndirectLengthPdf, makeIndirectLengthPdfWithFreeTarget, makeManyLargeHeadersPdf } from './support/pdf-indirect-length-fixture.js';

test('bounded structure parser resolves ImageMagick-style indirect stream Length scalars', () => {
  const source = makeIndirectLengthPdf();
  const structure = parsePdfStructure(source);
  const content = resolvePdfObject(structure, { type: 'ref', object: 4, generation: 0 });
  assert.equal(content.stream, true);
  assert.equal(content.streamLength, 4);
  assert.deepEqual(source.subarray(content.streamStart, content.streamStart + content.streamLength), Buffer.from('q\nQ\n'));
});

test('compact rewrite canonicalizes indirect stream Length and drops the scalar object', () => {
  const source = makeIndirectLengthPdf();
  const rewrite = buildPdfCompactRewrite(source);
  verifyPdfCompactRewrite({ sourceBytes: source, outputBytes: rewrite.bytes, expectedRewrite: rewrite });
  assert.equal(rewrite.bytes.includes(Buffer.from('/Length 5 0 R', 'latin1')), false);
  assert.equal(rewrite.bytes.includes(Buffer.from('5 0 obj', 'latin1')), false);
  const output = parseClassicPdfStructure(rewrite.bytes);
  const content = resolveClassicPdfObject(output, { type: 'ref', object: 4, generation: 0 });
  assert.equal(content.value.entries.get('Length').value, 4);
  assert.equal(content.streamLength, 4);
});

test('indirect stream Length admission fails closed for every hostile target shape', () => {
  const hostile = [
    makeIndirectLengthPdf({ includeLengthObject: false }),
    makeIndirectLengthPdf({ lengthValue: '6 0 R' }),
    makeIndirectLengthPdf({ lengthValue: '5 0 R' }),
    makeIndirectLengthPdf({ lengthValue: true }),
    makeIndirectLengthPdf({ lengthValue: -1 }),
    makeIndirectLengthPdf({ lengthValue: 256 * 1024 * 1024 + 1 }),
    makeIndirectLengthPdf({ lengthReference: '5 1 R' }),
    makeIndirectLengthPdfWithFreeTarget(),
  ];
  for (const source of hostile) {
    assert.throws(() => parsePdfStructure(source), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
  }
});

test('generic indirect-Length prepass shares the aggregate syntax budget across headers', () => {
  assert.throws(() => parsePdfStructure(makeManyLargeHeadersPdf()), { code: 'INVALID_CLASSIC_PDF_STRUCTURE' });
});
