import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  inspectIncrementalAnnotationFlatten,
  writeIncrementalAnnotationFlatten,
} from '../scripts/host/pdf-incremental-annotation-flatten-writer.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from '../scripts/host/pdf-classic-structure.mjs';

function classicPdf({
  annotationExtra = '', formExtra = '', formContent = 'q 0 0 1 RG 0 0 m 40 0 l 40 40 l 0 40 l h S Q',
  pageExtra = '', annots = '[5 0 R]', resources = '<< >>', contents = '4 0 R',
} = {}) {
  const formLength = Buffer.byteLength(formContent, 'latin1');
  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources ${resources} /Contents ${contents} /Annots ${annots}${pageExtra} >>`],
    [4, '<< /Length 3 >>\nstream\nq Q\nendstream'],
    [5, `<< /Type /Annot /Subtype /Square /F 4 /Rect [10 10 50 50] /AP << /N 6 0 R >>${annotationExtra} >>`],
    [6, `<< /Type /XObject /Subtype /Form /BBox [0 0 40 40] /Matrix [1 0 0 1 0 0] /Resources << >> /Length ${formLength}${formExtra} >>\nstream\n${formContent}\nendstream`],
  ]);
  let body = '%PDF-1.7\n';
  const offsets = new Map();
  for (const [number, value] of objects) {
    offsets.set(number, Buffer.byteLength(body, 'latin1'));
    body += `${number} 0 obj\n${value}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += 'xref\n0 7\n0000000000 65535 f \n';
  for (let number = 1; number <= 6; number += 1) {
    body += `${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size 7 /Root 1 0 R /ID [<${'11'.repeat(16)}> <${'22'.repeat(16)}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function request(source, overrides = {}) {
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const target = {
    page: 1, annotationIndex: 0,
    fingerprint: createHash('sha256').update(`pdfkit-inspector:opaque-locator:v1\nsource-sha256=${sourceSha256}\npage=1\nannotation-index=0\nsubtype=square\nwidget-type=none`).digest('hex'),
    subtype: 'square',
  };
  Object.assign(target, overrides);
  return { profile: 'local-square-annotation-flatten-v1', sourceSha256, target };
}

test('flattens the sole square normal appearance into a closed PDF', () => {
  const source = classicPdf();
  const result = writeIncrementalAnnotationFlatten(source, request(source));
  assert.equal(result.proof.closedClassicRevision, true);
  assert.equal(result.proof.annotationRemoved, true);
  assert.deepEqual(inspectIncrementalAnnotationFlatten(source, result.bytes, request(source)), result.proof);
  assert.equal(result.bytes.subarray(0, source.length).equals(source), false);
  assert.equal(result.bytes.includes(Buffer.from('/Subtype /Square', 'latin1')), false);
  const output = parseClassicPdfStructure(result.bytes);
  assert.equal(output.revisions.length, 1);
  assert.equal(output.revisions[0].trailer.has('Prev'), false);
  assert.throws(() => resolveClassicPdfObject(output, { type: 'ref', object: 5, generation: 0 }));
});

test('fails closed for locator, annotation, appearance, and page-profile drift', () => {
  const source = classicPdf();
  assert.throws(() => writeIncrementalAnnotationFlatten(source, request(source, { fingerprint: '0'.repeat(64) })), { code: 'UNSUPPORTED_ANNOTATION_FLATTEN_PDF' });
  for (const candidate of [
    classicPdf({ annotationExtra: ' /A << /S /Launch /F (tool.app) >>' }),
    classicPdf({ annotationExtra: ' /F 0' }),
    classicPdf({ formExtra: ' /Filter /FlateDecode' }),
    classicPdf({ formExtra: ' /Group << /S /Transparency >>' }),
    classicPdf({ formContent: 'BT ET' }),
    classicPdf({ pageExtra: ' /Rotate 90' }),
    classicPdf({ resources: '<< /XObject << >> >>' }),
  ]) assert.throws(() => writeIncrementalAnnotationFlatten(candidate, request(candidate)), { code: 'UNSUPPORTED_ANNOTATION_FLATTEN_PDF' });
});

test('installed Poppler renders the flattened appearance exactly like the source annotation', async (context) => {
  if (spawnSync('pdftocairo', ['-v']).error) { context.skip('Poppler is unavailable.'); return; }
  const source = classicPdf(); const result = writeIncrementalAnnotationFlatten(source, request(source));
  const directory = await mkdtemp(join(tmpdir(), 'annotation-flatten-writer-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.pdf'); const outputPath = join(directory, 'output.pdf');
  await Promise.all([writeFile(sourcePath, source), writeFile(outputPath, result.bytes)]);
  for (const [path, prefix] of [[sourcePath, 'source'], [outputPath, 'output']]) {
    const rendered = spawnSync('pdftocairo', ['-png', '-singlefile', '-scale-to', '256', path, join(directory, prefix)], { encoding: 'utf8' });
    assert.equal(rendered.status, 0, rendered.stderr);
  }
  assert.deepEqual(await readFile(join(directory, 'source.png')), await readFile(join(directory, 'output.png')));
});
