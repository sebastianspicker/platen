import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectIncrementalPdfGoToLink, writeIncrementalPdfGoToLink,
} from '../scripts/host/pdf-incremental-goto-link-writer.mjs';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parsePdfStructure, resolvePdfObject } from '../scripts/host/pdf-classic-structure.mjs';
import { pdfDictionary, pdfReference } from '../scripts/host/pdf-classic-syntax.mjs';
import { makeObjectStreamPdf, makeXrefStreamPdf } from './support/pdf-xref-stream-fixture.js';

const request = Object.freeze({
  profile: 'local-incremental-goto-link-v1', sourcePage: 1, targetPage: 1,
  rect: Object.freeze({ left: 10, bottom: 20, right: 80, top: 90 }),
});
const execFileAsync = promisify(execFile);

function classicPdf({ annots = null, pageExtra = '', objectFour = null, extraObject = null } = {}) {
  const indirect = annots === 'indirect'; const pageAnnots = annots === null ? '' : ` /Annots ${indirect ? '4 0 R' : annots}`;
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100]${pageAnnots}${pageExtra} >>`],
    [4, objectFour ?? (indirect ? '[]' : '<< /Length 0 >>\nstream\n\nendstream')],
  ]);
  if (extraObject !== null) bodies.set(5, extraObject);
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  for (const [number, body] of bodies) { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push(`xref\n0 ${bodies.size + 1}\n0000000000 65535 f \n`);
  for (let number = 1; number <= bodies.size; number += 1) chunks.push(`${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${bodies.size + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function annotationRefs(bytes) {
  const structure = parsePdfStructure(bytes); const page = pdfDictionary(resolvePdfObject(structure, { type: 'ref', object: 3, generation: 0 }).value);
  const value = page.get('Annots'); const array = value.type === 'ref' ? resolvePdfObject(structure, pdfReference(value)).value : value;
  return array.values.map(pdfReference);
}

test('writer appends exactly one direct-Dest Link to an annotation-less CropBox-contained page', () => {
  const source = classicPdf(); const result = writeIncrementalPdfGoToLink(source, request);
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(result.proof.annotationCount, 1);
  assert.equal(result.proof.linkAnnotationObjectNumber, 5);
  assert.deepEqual(inspectIncrementalPdfGoToLink(source, result.bytes, request), result.proof);
  const structure = parsePdfStructure(result.bytes); const annotation = pdfDictionary(resolvePdfObject(structure, { type: 'ref', object: 5, generation: 0 }).value);
  assert.equal(annotation.get('A'), undefined); assert.equal(annotation.get('Dest').values[1].value, 'Fit');
  assert.deepEqual(annotation.get('Rect').values.map(({ value }) => value), [10, 20, 80, 90]);
  assert.deepEqual(annotationRefs(result.bytes).map((value) => value.object), [5]);
});

test('writer preserves safely resolvable direct and indirect annotation arrays', () => {
  for (const source of [classicPdf({ annots: '[]' }), classicPdf({ annots: 'indirect' })]) {
    const result = writeIncrementalPdfGoToLink(source, request);
    assert.deepEqual(inspectIncrementalPdfGoToLink(source, result.bytes, request), result.proof);
    assert.equal(annotationRefs(result.bytes).at(-1).object, result.proof.linkAnnotationObjectNumber);
  }
});

test('writer accepts generic xref-stream and compressed-Catalog sources and preserves compressed provenance', () => {
  const extra = ' /CropBox [0 0 100 100]';
  for (const source of [
    makeXrefStreamPdf({ pageExtra: extra, xrefFilters: ['RunLengthDecode'] }),
    makeObjectStreamPdf({ compressedCatalog: true, pageExtra: extra, objectFilters: ['RunLengthDecode'], xrefFilters: ['ASCII85Decode', 'RunLengthDecode'] }),
  ]) {
    const result = writeIncrementalPdfGoToLink(source, request);
    assert.deepEqual(inspectIncrementalPdfGoToLink(source, result.bytes, request), result.proof);
    const output = parsePdfStructure(result.bytes); assert.equal(output.revisions[0].xrefKind, 'classic');
    assert.equal(output.revisions[1].xrefKind, 'stream');
  }
});

test('writer rejects malformed requests, unsafe source features, unsafe annotations, and out-of-CropBox rectangles', () => {
  const hostile = [
    classicPdf({ pageExtra: ' /AA <<>>' }), classicPdf({ pageExtra: ' /Metadata 4 0 R' }),
    classicPdf({ annots: '[4 0 R]', objectFour: '<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://example.test) >> >>' }),
    classicPdf({ pageExtra: ' /CropBox [0 0 50 50]' }),
    classicPdf({ pageExtra: ' /MediaBox [0 0 60 60]' }),
    classicPdf({ annots: '[4 0 R]', objectFour: '<< /Type /Annot /Subtype /Unknown >>' }),
    classicPdf({ annots: '[4 0 R]', objectFour: '<< /Type /Annot /Subtype /Text /AA <<>> >>' }),
    classicPdf({ extraObject: '<< /S /URI /URI (https://example.test) >>' }),
    classicPdf({ extraObject: '<< /S /Named /N /Print >>' }),
    classicPdf({ extraObject: '<< /ByteRange [0 1 2 3] >>' }),
  ];
  for (const source of hostile) assert.throws(() => writeIncrementalPdfGoToLink(Buffer.from(source, 'latin1'), request), { code: 'UNSUPPORTED_INCREMENTAL_GOTO_LINK_PDF' });
  assert.throws(() => writeIncrementalPdfGoToLink(classicPdf(), { ...request, rect: { ...request.rect, right: 101 } }), { code: 'UNSUPPORTED_INCREMENTAL_GOTO_LINK_PDF' });
  assert.throws(() => writeIncrementalPdfGoToLink(classicPdf(), { ...request, targetPage: 0 }), { code: 'INVALID_INCREMENTAL_GOTO_LINK' });
  const hidden = { sourcePage: request.sourcePage, targetPage: request.targetPage, rect: request.rect }; Object.defineProperty(hidden, 'profile', { value: request.profile });
  assert.throws(() => writeIncrementalPdfGoToLink(classicPdf(), hidden), { code: 'INVALID_INCREMENTAL_GOTO_LINK' });
  const shared = new SharedArrayBuffer(64); assert.throws(() => writeIncrementalPdfGoToLink(Buffer.from(shared), request), { code: 'UNSUPPORTED_INCREMENTAL_GOTO_LINK_PDF' });
});

test('installed Poppler reopens and renders a GoTo-link output from a compressed-Catalog source', async (context) => {
  const pdfinfo = '/opt/homebrew/bin/pdfinfo'; const pdftocairo = '/opt/homebrew/bin/pdftocairo';
  try { await Promise.all([access(pdfinfo), access(pdftocairo)]); } catch { context.skip('The fixed Poppler toolchain is unavailable.'); return; }
  const source = makeObjectStreamPdf({ compressedCatalog: true, pageExtra: ' /CropBox [0 0 100 100]', objectFilters: ['RunLengthDecode'], xrefFilters: ['ASCII85Decode', 'RunLengthDecode'] });
  const directory = await mkdtemp(join(tmpdir(), 'pdf-goto-link-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'output.pdf'); await writeFile(output, writeIncrementalPdfGoToLink(source, request).bytes);
  assert.match((await execFileAsync(pdfinfo, [output])).stdout, /^Pages:\s+1$/mu);
  const render = join(directory, 'render'); await execFileAsync(pdftocairo, ['-png', '-singlefile', '-f', '1', '-l', '1', output, render]); await access(`${render}.png`);
});

test('inspection rejects source-prefix and canonical-tail tampering', () => {
  const source = classicPdf(); const output = writeIncrementalPdfGoToLink(source, request).bytes;
  const prefix = Buffer.from(output); prefix[20] ^= 1;
  const tail = Buffer.from(output); tail[source.length + 5] ^= 1;
  for (const candidate of [prefix, tail]) assert.throws(() => inspectIncrementalPdfGoToLink(source, candidate, request), { code: 'INVALID_INCREMENTAL_GOTO_LINK_OUTPUT' });
});
