import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { pdfDictionary } from '../scripts/host/pdf-classic-syntax.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from '../scripts/host/pdf-classic-structure.mjs';
import { pendingClassicObjectReference, planClassicObjectTransaction } from '../scripts/host/pdf-classic-object-transaction.mjs';
import { PDF_PAGE_HEADER_FOOTER_PROFILE, normalizePdfPageHeaderFooter } from '../scripts/host/pdf-page-header-footer-contract.mjs';
import { inspectPdfPageHeaderFooter, writePdfPageHeaderFooter } from '../scripts/host/pdf-page-header-footer-writer.mjs';
const source = (options = {}) => makeMultiPagePdf(['one', 'two'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]], ...options });
const request = (bytes, pages = [1]) => ({ profile: PDF_PAGE_HEADER_FOOTER_PROFILE, sourceSha256: createHash('sha256').update(bytes).digest('hex'), pages, header: 'TOP', footerPrefix: 'Page ' });
const number = (value) => Object.freeze({ type: 'number', value, integer: Number.isSafeInteger(value), raw: String(value) });
const name = (value) => Object.freeze({ type: 'name', value });
const dictionary = (entries) => Object.freeze({ type: 'dict', entries: new Map(entries) });
const array = (values) => Object.freeze({ type: 'array', values: Object.freeze(values) });

function forgeUnselectedContentChange(input) {
  const structure = parseClassicPdfStructure(input);
  const catalog = pdfDictionary(resolveClassicPdfObject(structure, structure.root).value);
  const pagesReference = catalog.get('Pages');
  const pages = pdfDictionary(resolveClassicPdfObject(structure, pagesReference).value);
  const [selectedPageReference, unselectedPageReference] = pages.get('Kids').values;
  const selectedPage = pdfDictionary(resolveClassicPdfObject(structure, selectedPageReference).value);
  const unselectedPage = pdfDictionary(resolveClassicPdfObject(structure, unselectedPageReference).value);
  const unselectedContentReference = unselectedPage.get('Contents');
  const fontReference = pendingClassicObjectReference('font');
  const isolationPrefixReference = pendingClassicObjectReference('isolation-prefix');
  const isolationSuffixReference = pendingClassicObjectReference('isolation-suffix');
  const effectReference = pendingClassicObjectReference('content-1');
  const resources = new Map(selectedPage.get('Resources').entries);
  const fonts = new Map(resources.get('Font')?.entries ?? []);
  fonts.set('HeaderFooterMono', fontReference);
  resources.set('Font', dictionary(fonts));
  const selectedValue = new Map(selectedPage);
  selectedValue.set('Resources', dictionary(resources));
  selectedValue.set('Contents', array([
    isolationPrefixReference,
    selectedPage.get('Contents'),
    isolationSuffixReference,
    effectReference,
  ]));
  const effect = Buffer.from(
    'q\n0 0 0 rg\nBT\n/HeaderFooterMono 12 Tf\n295.2 762 Td\n<544F50> Tj\nET\n'
      + 'BT\n/HeaderFooterMono 12 Tf\n284.4 18 Td\n<506167652031> Tj\nET\nQ\n',
    'latin1',
  );
  const poisoned = Buffer.from('BT /F1 12 Tf 72 700 Td (UNSELECTED PAGE CHANGED) Tj ET\n', 'latin1');
  const transaction = planClassicObjectTransaction({
    sourceBytes: input,
    sourceStructure: structure,
    updates: [
      { reference: selectedPageReference, value: dictionary(selectedValue) },
      {
        reference: unselectedContentReference,
        value: dictionary([['Length', number(poisoned.length)]]),
        streamBytes: poisoned,
      },
    ],
    additions: [
      {
        id: 'font',
        value: dictionary([
          ['Type', name('Font')],
          ['Subtype', name('Type1')],
          ['BaseFont', name('Courier')],
          ['Encoding', name('WinAnsiEncoding')],
        ]),
      },
      { id: 'isolation-prefix', value: dictionary([['Length', number(2)]]), streamBytes: Buffer.from('q\n') },
      { id: 'isolation-suffix', value: dictionary([['Length', number(2)]]), streamBytes: Buffer.from('Q\n') },
      { id: 'content-1', value: dictionary([['Length', number(effect.length)]]), streamBytes: effect },
    ],
    info: { kind: 'preserve' },
    changingId: null,
  });
  return Buffer.concat([input, transaction.revision.bytes]);
}

function pdfWithContent(content, width = 612, streamDictionary = '') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 792] /CropBox [0 0 ${width} 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')}${streamDictionary} >>\nstream\n${content}endstream`,
  ];
  let body = '%PDF-1.7\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => { body += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
test('header/footer writer appends fixed header and automatic footer only to selected pages', () => { const input = source(); const value = request(input); const output = writePdfPageHeaderFooter(input, value); assert.ok(output.bytes.subarray(0, input.length).equals(input)); assert.deepEqual(inspectPdfPageHeaderFooter(input, output.bytes, value), output.proof); assert.deepEqual(output.proof.pages, [{ page: 1, applied: true }]); assert.match(output.bytes.toString('latin1'), /<544F50> Tj/); assert.match(output.bytes.toString('latin1'), /<506167652031> Tj/); });
test('header/footer contract rejects extras, accessors, text outside printable ASCII, and nonascending pages', () => { const input = source(); const value = request(input); assert.throws(() => normalizePdfPageHeaderFooter({ ...value, extra: true }), { code: 'INVALID_PDF_PAGE_HEADER_FOOTER' }); assert.throws(() => normalizePdfPageHeaderFooter({ ...value, header: 'x\n' }), { code: 'INVALID_PDF_PAGE_HEADER_FOOTER' }); assert.throws(() => normalizePdfPageHeaderFooter({ ...value, pages: [2, 1] }), { code: 'INVALID_PDF_PAGE_HEADER_FOOTER' }); const pages = [1]; Object.defineProperty(pages, '0', { get: () => 1, enumerable: true }); assert.throws(() => normalizePdfPageHeaderFooter({ ...value, pages }), { code: 'INVALID_PDF_PAGE_HEADER_FOOTER' }); });
test('header/footer writer rejects rotated pages and retained-output tampering', () => { const rotated = source({ rotations: [90, 0] }); assert.throws(() => writePdfPageHeaderFooter(rotated, request(rotated)), { code: 'UNSUPPORTED_PDF_PAGE_HEADER_FOOTER' }); const input = source(); const output = writePdfPageHeaderFooter(input, request(input)); const tampered = Buffer.from(output.bytes); tampered[tampered.length - 20] ^= 1; assert.throws(() => inspectPdfPageHeaderFooter(input, tampered, request(input)), { code: 'INVALID_PDF_PAGE_HEADER_FOOTER_OUTPUT' }); });

test('header/footer reinspection rejects an appended revision that rewrites unselected content', () => {
  const input = source();
  const value = request(input);
  const forged = forgeUnselectedContentChange(input);
  assert.throws(
    () => inspectPdfPageHeaderFooter(input, forged, value),
    { code: 'INVALID_PDF_PAGE_HEADER_FOOTER_OUTPUT' },
  );
});

test('header/footer writer isolates a persistent source clip before applying its effect', () => {
  const input = pdfWithContent('0 0 1 1 re W n\n');
  const value = request(input);
  const output = writePdfPageHeaderFooter(input, value);
  const structure = parseClassicPdfStructure(output.bytes);
  const catalog = pdfDictionary(resolveClassicPdfObject(structure, structure.root).value);
  const pages = pdfDictionary(resolveClassicPdfObject(structure, catalog.get('Pages')).value);
  const page = pdfDictionary(resolveClassicPdfObject(structure, pages.get('Kids').values[0]).value);
  const contents = page.get('Contents').values;
  assert.equal(contents.length, 4);
  const prefix = resolveClassicPdfObject(structure, contents[0]);
  const suffix = resolveClassicPdfObject(structure, contents[2]);
  assert.equal(output.bytes.subarray(prefix.streamStart, prefix.streamStart + prefix.streamLength).toString('latin1'), 'q\n');
  assert.equal(output.bytes.subarray(suffix.streamStart, suffix.streamStart + suffix.streamLength).toString('latin1'), 'Q\n');
  assert.deepEqual(inspectPdfPageHeaderFooter(input, output.bytes, value), output.proof);
});

test('header/footer reinspection rejects appended trailer authority', () => {
  const input = source();
  const value = request(input);
  const output = writePdfPageHeaderFooter(input, value).bytes;
  const trailerStart = output.lastIndexOf(Buffer.from('trailer\n', 'latin1'));
  const trailerEnd = output.indexOf(Buffer.from('>>', 'latin1'), trailerStart);
  const forged = Buffer.concat([
    output.subarray(0, trailerEnd),
    Buffer.from(' /Info 8 0 R', 'latin1'),
    output.subarray(trailerEnd),
  ]);
  assert.throws(
    () => inspectPdfPageHeaderFooter(input, forged, value),
    { code: 'INVALID_PDF_PAGE_HEADER_FOOTER_OUTPUT' },
  );
});

test('monospaced header fit rejects eighty wide glyphs outside a narrow page box', () => {
  const input = pdfWithContent('BT\n/F1 12 Tf\n72 720 Td\n(one) Tj\nET\n', 500);
  const value = { ...request(input), header: 'W'.repeat(80) };
  assert.throws(
    () => writePdfPageHeaderFooter(input, value),
    { code: 'INVALID_PDF_PAGE_HEADER_FOOTER' },
  );
});

test('header/footer admission rejects external-file content stream dictionaries', () => {
  const input = pdfWithContent('BT\n/F1 12 Tf\n72 720 Td\n(one) Tj\nET\n', 612, ' /F (external.bin)');
  assert.throws(
    () => writePdfPageHeaderFooter(input, request(input)),
    { code: 'UNSUPPORTED_PDF_PAGE_HEADER_FOOTER' },
  );
});
