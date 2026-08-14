import assert from 'node:assert/strict';
import test from 'node:test';
import { findFinalStartXref } from '../scripts/host/pdf-classic-syntax.mjs';
import { normalizeIncrementalAccessibilityMetadata } from '../scripts/host/pdf-incremental-accessibility-metadata-contract.mjs';
import { inspectIncrementalPdfAccessibilityMetadata, writeIncrementalPdfAccessibilityMetadata } from '../scripts/host/pdf-incremental-accessibility-metadata-writer.mjs';
import { assertAccessibilityProof } from '../scripts/host/pdf-incremental-accessibility-metadata-validation.mjs';

const request = Object.freeze({ language: 'EN-Latn-us', title: 'Résumé 😀' });

function fixture({ catalog = '<< /Type /Catalog /Pages 2 0 R >>', catalogGeneration = 0, info = null, id = null, size = 5, extra = '', additionalObjects = [] } = {}) {
  const objects = [[1, catalogGeneration, catalog], [2, 0, '<< /Type /Pages /Count 0 /Kids [] >>']];
  if (info !== null) objects.push([4, 0, info]);
  objects.push(...additionalObjects);
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  for (const [number, generation, body] of objects) { offsets.set(number, { generation, offset: Buffer.byteLength(chunks.join(''), 'latin1') }); chunks.push(`${number} ${generation} obj\n${body}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 1\n0000000000 65535 f \n');
  for (const [number, entry] of offsets) chunks.push(`${number} 1\n${String(entry.offset).padStart(10, '0')} ${String(entry.generation).padStart(5, '0')} n \n`);
  chunks.push(`trailer\n<< /Size ${size} /Root 1 ${catalogGeneration} R${info === null ? '' : ' /Info 4 0 R'}${id ? ` /ID [<${id[0]}> <${id[1]}>]` : ''}${extra} >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

test('contract rejects hostile shapes and normalizes language deterministically', () => {
  assert.deepEqual(normalizeIncrementalAccessibilityMetadata(request), { language: 'en-latn-us', title: 'Résumé 😀' });
  assert.equal(normalizeIncrementalAccessibilityMetadata({ language: 'zh-Hant-CN', title: 'x' }).language, 'zh-hant-cn');
  assert.equal(normalizeIncrementalAccessibilityMetadata({ language: 'es-419', title: 'x' }).language, 'es-419');
  const accessor = { language: 'en', title: 'Title' }; Object.defineProperty(accessor, 'title', { get: () => 'Title', enumerable: true });
  let proxyTraps = 0;
  const proxy = new Proxy({ language: 'en', title: 'x' }, {
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
    ownKeys(target) { proxyTraps += 1; return Reflect.ownKeys(target); },
  });
  const hostile = [null, [], { language: 'e', title: 'x' }, { language: 'en--us', title: 'x' }, { language: 'en-12', title: 'x' }, { language: 'en-US-GB', title: 'x' }, { language: 'en-419-US', title: 'x' }, { language: 'en-Latn-US-extra', title: 'x' }, { language: 'en', title: '' }, { language: 'en', title: ' x' }, { language: 'en', title: 'a\0b' }, { language: 'en', title: '\u202Etitle' }, { language: 'en', title: 'e\u0301' }, { language: 'en', title: '\ud800' }, accessor, proxy];
  const symbol = { language: 'en', title: 'x' }; symbol[Symbol('extra')] = true; hostile.push(symbol);
  for (const value of hostile) assert.throws(() => normalizeIncrementalAccessibilityMetadata(value), { code: 'INVALID_INCREMENTAL_ACCESSIBILITY_METADATA' });
  assert.throws(() => normalizeIncrementalAccessibilityMetadata({ language: 'en', title: 'x'.repeat(257) }), { code: 'INVALID_INCREMENTAL_ACCESSIBILITY_METADATA' });
  assert.equal(proxyTraps, 0);
});

test('writer deterministically rewrites Catalog and allocates a preserving Info dictionary', () => {
  const source = fixture({ info: '<< /Producer (Fixture) /Custom << /Flag true >> >>' });
  const first = writeIncrementalPdfAccessibilityMetadata(source, request);
  const second = writeIncrementalPdfAccessibilityMetadata(source, request);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(first.proof.catalogObjectNumber, 1);
  assert.equal(first.proof.infoObjectNumber, 5);
  assert.equal(first.proof.rootPreserved, true);
  assert.equal(first.proof.previousXrefOffset, findFinalStartXref(source));
  const tail = first.bytes.subarray(source.length).toString('latin1');
  assert.match(tail, /1 0 obj\n<< \/Lang <FEFF0065006E002D006C00610074006E002D00750073> \/Pages 2 0 R \/Type \/Catalog >>/);
  assert.match(tail, /5 0 obj\n<< \/Custom << \/Flag true >> \/Producer <46697874757265> \/Title <FEFF/);
  assert.deepEqual(inspectIncrementalPdfAccessibilityMetadata(source, first.bytes, request), first.proof);
});

test('writer admits absent Info, preserves permanent ID, and changes deterministic changing ID', () => {
  const source = fixture({ id: ['11'.repeat(16), '22'.repeat(16)] });
  const result = writeIncrementalPdfAccessibilityMetadata(source, request);
  assert.equal(result.proof.infoObjectNumber, 5);
  assert.equal(result.proof.idPolicy, 'permanent-preserved-changing-updated');
  const ids = /\/ID \[<([0-9A-F]+)> <([0-9A-F]+)>\]/.exec(result.bytes.subarray(source.length).toString('latin1'));
  assert.equal(ids[1], '11'.repeat(16).toUpperCase()); assert.equal(ids[2].length, 32);
});

test('proof validation preserves an admitted nonzero Catalog generation', () => {
  const source = fixture({ catalogGeneration: 1 });
  const result = writeIncrementalPdfAccessibilityMetadata(source, request);
  assert.equal(result.proof.catalogGeneration, 1);
  assert.equal(
    assertAccessibilityProof(result.proof, source.length, result.bytes.length),
    result.proof,
  );
});

test('writer rejects pre-existing language, title, Metadata, unsupported xref, and proof tampering', () => {
  const hostile = [
    fixture({ catalog: '<< /Type /Catalog /Pages 2 0 R /Lang (en) >>' }),
    fixture({ info: '<< /Title (Old) >>' }),
    fixture({ catalog: '<< /Type /Catalog /Pages 2 0 R /Metadata 4 0 R >>' }),
    fixture({ catalog: '<< /Type /Catalog >>' }),
    fixture({ catalog: '<< /Type /Catalog /Pages 2 0 R /Open#41ction 4 0 R >>', info: '<< /Type /Action /S /JavaScript >>' }),
    fixture({ additionalObjects: [[3, 0, '<< /Type /XObject /Subtype /PS /Length 0 >>\nstream\n\nendstream']] }),
    fixture({ extra: ' /XRefStm 9' }),
  ];
  for (const source of hostile) assert.throws(() => writeIncrementalPdfAccessibilityMetadata(source, request), { code: 'UNSUPPORTED_INCREMENTAL_ACCESSIBILITY_METADATA_PDF' });
  const source = fixture(); const result = writeIncrementalPdfAccessibilityMetadata(source, request);
  const tampered = Buffer.from(result.bytes); tampered[tampered.length - 8] ^= 1;
  assert.throws(() => inspectIncrementalPdfAccessibilityMetadata(source, tampered, request), { code: 'INVALID_INCREMENTAL_ACCESSIBILITY_METADATA_OUTPUT' });
});
