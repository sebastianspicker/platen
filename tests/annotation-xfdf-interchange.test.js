import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBlankPdf } from '../scripts/host/pdf-factory.mjs';
import { parsePdfStructure, resolvePdfObject } from '../scripts/host/pdf-classic-structure.mjs';
import { pdfDictionary } from '../scripts/host/pdf-classic-syntax.mjs';
import { pdfUtf16BeString } from '../scripts/host/pdf-classic-text-string.mjs';
import {
  exportCanonicalTextAnnotationXfdf,
  parseCanonicalTextAnnotationXfdf,
} from '../scripts/host/professional-capability/annotation-xfdf-interchange.mjs';
import { writeInertPageAnnotation } from '../scripts/host/professional-capability/inert-annotation-writer.mjs';

const header = '<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots>';
const footer = '</annots></xfdf>\n';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function xfdf({ page = 0, rect = '10.5,20,80,90.25', name = 'note-1', contents = 'A &lt; B &amp; C &gt; D &quot;quoted&quot; &apos;tick&apos; &amp; more' } = {}) {
  const includeName = name !== undefined && name !== null;
  return `${header}<text page="${page}" rect="${rect}"${includeName ? ` name="${name}"` : ''}><contents>${contents}</contents></text>${footer}`;
}

function context(payload = xfdf()) {
  const sourcePdf = createBlankPdf({ pages: 1, title: 'xfdf-source' });
  return { sourcePdf, sourceSha256: digest(sourcePdf), xfdf: payload };
}

function exerciseInterchange(input) {
  const imported = parseCanonicalTextAnnotationXfdf(input.xfdf);
  const written = writeInertPageAnnotation(input.sourcePdf, imported);
  const exported = exportCanonicalTextAnnotationXfdf(imported);
  return Object.freeze({
    imported,
    xfdf: exported,
    pdf: written.bytes,
    proof: written.proof,
    sourceSha256: digest(input.sourcePdf),
    outputSha256: written.proof.outputSha256,
    importSha256: digest(Buffer.from(input.xfdf)),
    exportSha256: digest(Buffer.from(exported)),
  });
}

function lastAnnotation(pdf) {
  const structure = parsePdfStructure(pdf);
  const catalog = pdfDictionary(resolvePdfObject(structure, structure.root).value);
  const pages = pdfDictionary(resolvePdfObject(structure, catalog.get('Pages')).value);
  const page = pdfDictionary(resolvePdfObject(structure, pages.get('Kids').values[0]).value);
  const reference = page.get('Annots').values.at(-1);
  return pdfDictionary(resolvePdfObject(structure, reference).value);
}

test('XFDF Text annotation round-trips escaped text and applies the exact record', () => {
  const input = context();
  const outcome = exerciseInterchange(input);
  const expectedContents = 'A < B & C > D "quoted" \'tick\' & more';
  assert.equal(outcome.imported.contents, expectedContents);
  assert.equal(outcome.xfdf, xfdf());
  assert.equal(outcome.importSha256, digest(Buffer.from(input.xfdf)));
  assert.equal(outcome.exportSha256, outcome.importSha256);
  assert.equal(outcome.sourceSha256, input.sourceSha256);
  assert.equal(outcome.outputSha256, digest(outcome.pdf));
  assert.equal(outcome.proof.outputSha256, outcome.outputSha256);

  const annotation = lastAnnotation(outcome.pdf);
  assert.equal(annotation.get('Subtype').value, 'Text');
  assert.deepEqual(annotation.get('Rect').values.map(({ value }) => value), [10.5, 20, 80, 90.25]);
  assert.deepEqual(annotation.get('Contents').bytes, pdfUtf16BeString(expectedContents).bytes);
  assert.deepEqual(annotation.get('NM').bytes, pdfUtf16BeString('note-1').bytes);
  assert.equal(annotation.get('NM').bytes.toString('latin1'), pdfUtf16BeString('note-1').bytes.toString('latin1'));
});

test('XFDF import accepts missing optional name and omits output name state', () => {
  const input = context(xfdf({
    name: null,
    contents: 'No &apos;name&apos; required; entities resolve to &amp; char.',
  }));
  const outcome = exerciseInterchange(input);
  assert.equal('name' in outcome.imported, false);
  assert.equal(outcome.xfdf.includes(' name='), false);
  assert.equal(outcome.proof.outputSha256, outcome.outputSha256);

  const annotation = lastAnnotation(outcome.pdf);
  assert.equal(annotation.get('Subtype').value, 'Text');
  assert.equal(annotation.get('NM'), undefined);
});

test('XFDF import rejects declarations, entity injection, extra records, and oversized input', () => {
  const hostile = [
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xfdf [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><xfdf/>\n',
    xfdf({ contents: '&xxe;' }),
    `${header}<text page="0" rect="1,1,2,2"><contents>one</contents></text><text page="0" rect="2,2,3,3"><contents>two</contents></text>${footer}`,
    `${header}<text page="0" rect="1,1,2,2" extra="1"><contents>one</contents></text>${footer}`,
    `${xfdf()}${' '.repeat(16 * 1024)}`,
    xfdf({ contents: 'A &amplt; B' }),
    xfdf({ contents: 'A &unknown; B' }),
  ];
  for (const payload of hostile) {
    assert.throws(() => exerciseInterchange(context(payload)), { code: 'INVALID_ANNOTATION_XFDF', status: 400 });
  }
});

test('XFDF import rejects invalid page, rectangle, controls, and non-XFDF formats', () => {
  for (const payload of [
    xfdf({ page: 9999 }),
    xfdf({ rect: '10,10,5,20' }),
    xfdf({ contents: 'bad\u0001text' }),
    JSON.stringify({ subtype: 'Text', page: 1 }),
  ]) {
    assert.throws(() => exerciseInterchange(context(payload)), { code: 'INVALID_ANNOTATION_XFDF' });
  }
});
