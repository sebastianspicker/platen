import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { parseClassicPdfStructure, parsePdfStructure } from '../scripts/host/pdf-classic-structure.mjs';
import { resolvePdfObject } from '../scripts/host/pdf-classic-structure.mjs';
import { resolvePdfPageTree } from '../scripts/host/pdf-page-tree-resolver.mjs';
import { tokenizePdfContentStream } from '../scripts/host/pdf-content-stream-tokenizer.mjs';
import {
  PDF_PAGE_CONTENT_FOUNDATION_PROFILE,
  PDF_PAGE_CONTENT_FOUNDATION_LIMITS,
  inspectPageContentFoundation,
  writePageContentFoundation,
} from '../scripts/host/pdf-page-content-foundation.mjs';
import { makeObjectStreamPdf, makeXrefStreamPdf } from './support/pdf-xref-stream-fixture.js';

const number = (value) => Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw: String(value) });
const name = (value) => Object.freeze({ type: 'name', value });
const dict = (entries) => Object.freeze({ type: 'dict', entries: new Map(entries) });

function streamBody(payload, extra = '') {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'latin1');
  return `<< /Length ${bytes.length}${extra} >>\nstream\n${bytes.toString('latin1')}\nendstream`;
}
function streamBodyWithLength(payload, length, extra = '') {
  return `<< /Length ${length}${extra} >>\nstream\n${Buffer.isBuffer(payload) ? payload.toString('latin1') : Buffer.from(payload, 'latin1').toString('latin1')}\nendstream`;
}

function referenceText(reference) {
  return `${reference.object} ${reference.generation} R`;
}
function normalizeContents(value) {
  if (value === undefined) return [];
  if (value?.type === 'ref') return [value];
  if (value?.type === 'array') return [...value.values];
  return [];
}

function foundationPdf({ shareAcrossPages = false, duplicateWithinFirst = false, filtered = false, wrongLength = false } = {}) {
  const pageOneContents = duplicateWithinFirst ? '[7 0 R 7 0 R]' : '7 0 R';
  const pageTwoContents = shareAcrossPages ? '7 0 R' : '8 0 R';
  const streamOne = wrongLength
    ? streamBodyWithLength('q Q', 2, filtered ? ' /Filter /FlateDecode' : '')
    : streamBody('q Q', filtered ? ' /Filter /FlateDecode' : '');
  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 100 100] >>`],
    [3, `<< /Type /Page /Parent 2 0 R /Contents ${pageOneContents} >>`],
    [4, `<< /Type /Page /Parent 2 0 R /Contents ${pageTwoContents} >>`],
    [5, '<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>'],
    [6, streamBody('noop')],
    [7, streamOne],
    [8, streamBody('BT ET')],
  ]);
  return classicPdf(objects);
}

const foundationRequest = Object.freeze({
  profile: PDF_PAGE_CONTENT_FOUNDATION_PROFILE,
  edits: [{ page: 1, position: 'append', content: 'q 0 0 0 rg Q' }],
});

function classicPdf(objects, root = 1) {
  const header = '%PDF-1.7\n';
  const chunks = [Buffer.from(header, 'latin1')];
  const offsets = [0];
  for (let object = 1; object <= Math.max(...objects.keys()); object += 1) {
    const body = objects.get(object);
    assert.ok(body, `fixture object ${object} is present`);
    offsets[object] = Buffer.concat(chunks).length;
    chunks.push(Buffer.from(`${object} 0 obj\n${body}\nendobj\n`, 'latin1'));
  }
  const xrefOffset = Buffer.concat(chunks).length;
  const rows = [`xref\n0 ${offsets.length}`, '0000000000 65535 f '];
  for (let object = 1; object < offsets.length; object += 1) rows.push(`${String(offsets[object]).padStart(10, '0')} 00000 n `);
  rows.push(`trailer\n<< /Size ${offsets.length} /Root ${root} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  chunks.push(Buffer.from(`${rows.join('\n')}\n`, 'latin1'));
  return Buffer.concat(chunks);
}

function pageTreeFixture({ count = 2, kids = '[3 0 R 4 0 R]', pagesExtra = '', pageThree = null } = {}) {
  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Count ${count} /Kids ${kids} /MediaBox [0 0 200 300] /CropBox 6 0 R /Rotate 90 /Resources 5 0 R${pagesExtra} >>`],
    [3, pageThree ?? '<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>'],
    [4, '<< /Type /Page /Parent 2 0 R /MediaBox 10 0 R /Rotate 180 /Contents [8 0 R 9 0 R] >>'],
    [5, '<< /ProcSet [/PDF] >>'],
    [6, '[10 20 180 280]'],
    [7, streamBody('q Q')],
    [8, streamBody('BT')],
    [9, streamBody('ET')],
    [10, '[0 0 100 150]'],
  ]);
  return classicPdf(objects);
}

function contentStream(bytes, entries = []) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'latin1');
  return Object.freeze({
    stream: true,
    streamStart: 0,
    streamLength: payload.length,
    value: dict([['Length', number(payload.length)], ...entries]),
  });
}

function tokenize(source, entries = [], options = {}) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, 'latin1');
  return tokenizePdfContentStream({ ...options, stream: contentStream(bytes, entries), encodedBytes: bytes });
}

test('page resolver walks classic inherited geometry and all Contents forms', () => {
  const result = resolvePdfPageTree({ structure: parseClassicPdfStructure(pageTreeFixture()) });
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.pages.map(({ mediaBox, cropBox, rotate, contents }) => ({ mediaBox, cropBox, rotate, contents: contents.length })), [
    { mediaBox: [0, 0, 200, 300], cropBox: [10, 20, 180, 280], rotate: 90, contents: 1 },
    { mediaBox: [0, 0, 100, 150], cropBox: [10, 20, 180, 280], rotate: 180, contents: 2 },
  ]);
  assert.equal(result.pages[0].contents[0].streamLength, 3);
  assert.equal(result.pages[1].contents[0].streamLength, 2);
  assert.equal(result.pages[1].contents[1].streamLength, 2);
  assert.equal(result.pages[0].resources.entries.has('ProcSet'), true);
  result.pages[0].resources.entries.set('Mutated', name('isolated'));
  assert.equal(result.pages[1].resources.entries.has('Mutated'), false);
});

test('page resolver accepts xref-stream and compressed-catalog object-stream structures', () => {
  for (const source of [makeXrefStreamPdf(), makeObjectStreamPdf({ compressedCatalog: true })]) {
    const structure = parsePdfStructure(source);
    const result = resolvePdfPageTree({ structure });
    assert.equal(result.pageCount, 1);
    assert.deepEqual(result.pages[0].mediaBox, [0, 0, 100, 100]);
    assert.equal(result.pages[0].contents.length, 1);
  }
});

test('page resolver rejects count mismatches, duplicate/cyclic kids, and bounds', () => {
  assert.throws(() => resolvePdfPageTree({ structure: parseClassicPdfStructure(pageTreeFixture({ count: 1 })) }), { code: 'INVALID_PDF_PAGE_TREE' });
  assert.throws(() => resolvePdfPageTree({ structure: parseClassicPdfStructure(pageTreeFixture({ count: 2, kids: '[3 0 R 3 0 R]' })) }), { code: 'INVALID_PDF_PAGE_TREE' });
  const cycle = pageTreeFixture({ count: 1, kids: '[2 0 R]' });
  assert.throws(() => resolvePdfPageTree({ structure: parseClassicPdfStructure(cycle) }), { code: 'INVALID_PDF_PAGE_TREE' });
  // A nested Pages node reaches depth 2, beyond this request's depth budget.
  const nestedObjects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [11 0 R] >>'],
    [4, 'null'], [5, 'null'], [6, 'null'], [7, 'null'], [8, 'null'], [9, 'null'], [10, 'null'],
    [11, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 11 0 R /MediaBox [0 0 10 10] >>'],
  ]);
  assert.throws(() => resolvePdfPageTree({ structure: parseClassicPdfStructure(classicPdf(nestedObjects)), limits: { maxDepth: 1 } }), { code: 'INVALID_PDF_PAGE_TREE' });
  assert.throws(() => resolvePdfPageTree({ structure: parseClassicPdfStructure(pageTreeFixture()), limits: { maxNodes: 2 } }), { code: 'INVALID_PDF_PAGE_TREE' });
});

test('page resolver permits absent Contents but rejects malformed streams and boxes', () => {
  const noContents = pageTreeFixture({ pageThree: '<< /Type /Page /Parent 2 0 R >>' });
  assert.deepEqual(resolvePdfPageTree({ structure: parseClassicPdfStructure(noContents) }).pages[0].contents, []);
  const badContents = pageTreeFixture({ pageThree: '<< /Type /Page /Parent 2 0 R /Contents 11 0 R >>' });
  assert.throws(() => resolvePdfPageTree({ structure: parseClassicPdfStructure(badContents) }), { code: 'INVALID_PDF_PAGE_TREE' });
  const parsed = parseClassicPdfStructure(pageTreeFixture());
  assert.throws(() => resolvePdfPageTree({ structure: Object.freeze({ ...parsed, xrefFlavor: 'unsupported' }) }), { code: 'INVALID_PDF_PAGE_TREE' });
  assert.ok(badContents);
});

test('content tokenizer handles literals, hex strings, names, arrays, dictionaries, comments, and Flate', () => {
  const result = tokenize('% comment\n(B\\nC\\053\\101\\\nD( nested )) <A1f> /Name#20X [1 -2.5] << /Key (v) >>', []);
  assert.deepEqual([...result.tokens].filter((token) => token.type === 'string').map((token) => token.bytes.toString('latin1')), ['B\nC+AD( nested )', Buffer.from([0xa1, 0xf0]).toString('latin1'), 'v']);
  assert.deepEqual(result.tokens.filter((token) => token.type === 'name').map((token) => token.value), ['Name X', 'Key']);
  const flate = tokenize(deflateSync(Buffer.from('1 2 m', 'latin1')), [['Filter', name('FlateDecode')]]);
  assert.equal(flate.decodedBytes, 5);
  assert.deepEqual(flate.tokens.filter((token) => token.type === 'operator').map((token) => token.value), ['m']);
});

test('content tokenizer snapshots unfiltered bytes and rejects unsupported or malformed constructs', () => {
  const source = Buffer.from('q Q', 'latin1');
  const result = tokenize(source);
  result.bytes[0] = 0x78;
  assert.equal(source.toString('latin1'), 'q Q');
  for (const input of ['[1', '1]', '<< /Key >>', 'BI /W 1 ID x EI', '1 0 R']) {
    assert.throws(() => tokenize(input), { code: 'INVALID_PDF_CONTENT_STREAM' });
  }
  assert.throws(() => tokenize('1', [['Filter', name('LZWDecode')]]), { code: 'INVALID_PDF_CONTENT_STREAM' });
});

test('content tokenizer enforces token, byte, nesting, string, and name limits', () => {
  assert.throws(() => tokenize('1 2', [], { limits: { maxTokens: 1 } }), { code: 'INVALID_PDF_CONTENT_STREAM' });
  assert.throws(() => tokenize('123', [], { limits: { maxDecodedBytes: 2 } }), { code: 'INVALID_PDF_CONTENT_STREAM' });
  assert.throws(() => tokenize('[[1]]', [], { limits: { maxNesting: 1 } }), { code: 'INVALID_PDF_CONTENT_STREAM' });
  assert.throws(() => tokenize('(abc)', [], { limits: { maxStringBytes: 2 } }), { code: 'INVALID_PDF_CONTENT_STREAM' });
  assert.throws(() => tokenize('/abc', [], { limits: { maxNameBytes: 2 } }), { code: 'INVALID_PDF_CONTENT_STREAM' });
  assert.throws(() => tokenize('123', [], { limits: { maxEncodedBytes: 2 } }), { code: 'INVALID_PDF_CONTENT_STREAM' });
});

test('writes and inspects classic page-content foundation output with deterministic proof', () => {
  const source = foundationPdf();
  const result = writePageContentFoundation(source, foundationRequest);
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(result.bytes.includes(Buffer.from(foundationRequest.edits[0].content, 'latin1')), true);
  const expected = inspectPageContentFoundation(source, result.bytes, foundationRequest);
  assert.deepEqual(expected, result.proof);
  assert.equal(expected.appendedBytes > 0, true);
  assert.equal(expected.sourceContentStreams, 2);
  assert.equal(expected.edits[0].page, 1);
  const written = parsePdfStructure(result.bytes);
  const pageOne = resolvePdfObject(written, { type: 'ref', object: 3, generation: 0 });
  const pageTwo = resolvePdfObject(written, { type: 'ref', object: 4, generation: 0 });
  const pageOneContents = normalizeContents(pageOne.value.entries.get('Contents'));
  const pageTwoContents = normalizeContents(pageTwo.value.entries.get('Contents'));
  assert.equal(pageOneContents.at(-1).object, expected.edits[0].objectNumber);
  assert.equal(pageTwoContents.length, 1);
  assert.equal(referenceText(pageTwoContents[0]), '8 0 R');
});

test('inspecting a tampered write output changes the output proof and rejects', () => {
  const source = foundationPdf();
  const result = writePageContentFoundation(source, foundationRequest);
  const tampered = Buffer.from(result.bytes);
  tampered[tampered.length - 10] ^= 0xff;
  assert.throws(() => inspectPageContentFoundation(source, tampered, foundationRequest), {
    code: 'INVALID_PAGE_CONTENT_FOUNDATION_OUTPUT',
  });
});

test('rejects unsupported foundations with shared or filtered/ambiguous content streams', () => {
  const shared = foundationPdf({ shareAcrossPages: true });
  assert.throws(() => writePageContentFoundation(shared, foundationRequest), {
    code: 'UNSUPPORTED_PAGE_CONTENT_FOUNDATION',
  });
  const duplicate = foundationPdf({ duplicateWithinFirst: true });
  assert.throws(() => writePageContentFoundation(duplicate, foundationRequest), {
    code: 'UNSUPPORTED_PAGE_CONTENT_FOUNDATION',
  });
  const filtered = foundationPdf({ filtered: true });
  assert.throws(() => writePageContentFoundation(filtered, foundationRequest), {
    code: 'UNSUPPORTED_PAGE_CONTENT_FOUNDATION',
  });
  const wrong = foundationPdf({ wrongLength: true });
  assert.throws(() => writePageContentFoundation(wrong, foundationRequest), {
    code: 'UNSUPPORTED_PAGE_CONTENT_FOUNDATION',
  });
});

test('writes page-content foundation for xref-stream structure', () => {
  const source = makeXrefStreamPdf();
  const result = writePageContentFoundation(source, foundationRequest);
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  const proof = inspectPageContentFoundation(source, result.bytes, foundationRequest);
  assert.equal(proof.sourcePrefixPreserved, true);
  assert.equal(proof.sourcePageObjectNumber, 5);
  assert.equal(proof.sourceContentStreams, 1);
});

test('writes ordered prepend and append edits across two pages and preserves existing arrays', () => {
  const source = pageTreeFixture();
  const request = {
    profile: PDF_PAGE_CONTENT_FOUNDATION_PROFILE,
    edits: [
      { page: 1, position: 'prepend', content: 'q Q' },
      { page: 1, position: 'prepend', content: '1 0 0 1 0 0 cm' },
      { page: 1, position: 'append', content: '0 0 m S' },
      { page: 2, position: 'prepend', content: 'q Q' },
      { page: 2, position: 'append', content: '0 0 10 10 re f' },
    ],
  };
  const result = writePageContentFoundation(source, request);
  const output = parsePdfStructure(result.bytes);
  const pageTree = resolvePdfPageTree({ structure: parseClassicPdfStructure(result.bytes) });
  const pageOneContents = normalizeContents(resolvePdfObject(output, pageTree.pages[0].reference).value.entries.get('Contents'));
  const pageTwoContents = normalizeContents(resolvePdfObject(output, pageTree.pages[1].reference).value.entries.get('Contents'));
  assert.deepEqual(pageOneContents.map(referenceText), [
    result.proof.edits[0].reference,
    result.proof.edits[1].reference,
    '7 0 R',
    result.proof.edits[2].reference,
  ]);
  assert.deepEqual(pageTwoContents.map(referenceText), [
    result.proof.edits[3].reference,
    '8 0 R', '9 0 R',
    result.proof.edits[4].reference,
  ]);
  assert.deepEqual(result.proof.edits.map(({ page, position }) => ({ page, position })), request.edits.map(({ page, position }) => ({ page, position })));
});

test('rejects malformed or unsafe inserted content and edit shapes', () => {
  const source = foundationPdf();
  const base = (content) => ({ profile: PDF_PAGE_CONTENT_FOUNDATION_PROFILE, edits: [{ page: 1, position: 'append', content }] });
  for (const content of ['', 'q', 'Q', 'BT ET', 'BMC EMC', 'BI /W 1 ID x EI', '/Name', '1 2 bogus', '1 m', '[3 2] 0 d', '1 2 d']) {
    assert.throws(() => writePageContentFoundation(source, base(content)), { code: 'INVALID_PAGE_CONTENT_FOUNDATION' });
  }
  assert.throws(() => writePageContentFoundation(source, { profile: PDF_PAGE_CONTENT_FOUNDATION_PROFILE, edits: [] }), { code: 'INVALID_PAGE_CONTENT_FOUNDATION' });
  assert.throws(() => writePageContentFoundation(source, { profile: PDF_PAGE_CONTENT_FOUNDATION_PROFILE, edits: Array.from({ length: 65 }, () => ({ page: 1, position: 'append', content: 'q Q' })) }), { code: 'INVALID_PAGE_CONTENT_FOUNDATION' });
  const oversized = ' '.repeat(PDF_PAGE_CONTENT_FOUNDATION_LIMITS.maxAppendBytes + 1);
  assert.throws(() => writePageContentFoundation(source, base(oversized)), { code: 'INVALID_PAGE_CONTENT_FOUNDATION' });
  const symbolic = [{ page: 1, position: 'append', content: 'q Q' }];
  symbolic.extra = true;
  assert.throws(() => writePageContentFoundation(source, { profile: PDF_PAGE_CONTENT_FOUNDATION_PROFILE, edits: symbolic }), { code: 'INVALID_PAGE_CONTENT_FOUNDATION' });
});
