import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  inspectIncrementalPdfNamedDestination,
  writeIncrementalPdfNamedDestination,
} from '../scripts/host/pdf-incremental-named-destination-writer.mjs';

const request = Object.freeze({
  profile: 'local-incremental-named-destination-v1', targetPage: 1, name: 'chapter-one',
});

function pdf({ catalog = '<< /Type /Catalog /Pages 2 0 R >>', pageSuffix = '', stream = false } = {}) {
  const objects = [
    catalog,
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100]${stream ? ' /Contents 4 0 R' : ''}${pageSuffix} >>`,
    ...(stream ? ['<< /Length 0 >>\nstream\n\nendstream'] : []),
  ];
  let body = '%PDF-1.7\n'; const offsets = [];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(body, 'latin1'); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => { body += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(`${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

test('writes one deterministic root revision while preserving a normal page contents stream', () => {
  const source = pdf({ stream: true }); const first = writeIncrementalPdfNamedDestination(source, request);
  const second = writeIncrementalPdfNamedDestination(Buffer.from(source), request);
  assert.deepEqual(first.bytes, second.bytes); assert.equal(first.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(first.proof.name, undefined); assert.match(first.proof.nameSha256, /^[0-9a-f]{64}$/u);
  assert.equal(first.proof.effectiveSize, 5); assert.equal(first.proof.targetPageObjectNumber, 3);
  assert.deepEqual(inspectIncrementalPdfNamedDestination(source, first.bytes, request), first.proof);
});

test('enforces exact destination-name grammar and rejects hostile source semantics', () => {
  for (const name of ['!unsafe', 'with space', 'a(b)', 'a/b', 'x'.repeat(65)]) {
    assert.throws(() => writeIncrementalPdfNamedDestination(pdf(), { ...request, name }), { code: 'INVALID_INCREMENTAL_NAMED_DESTINATION' });
  }
  assert.throws(() => writeIncrementalPdfNamedDestination(pdf(), { ...request, targetPage: 2 }), { code: 'UNSUPPORTED_INCREMENTAL_NAMED_DESTINATION_PDF' });
  const hostile = [
    pdf({ catalog: '<< /Type /Catalog /Pages 2 0 R /Names <<>> >>' }),
    pdf({ catalog: '<< /Type /Catalog /Pages 2 0 R /OpenAction 3 0 R >>' }),
    pdf({ pageSuffix: ' /AA <<>>' }),
    pdf({ pageSuffix: ' /A << /S /GoTo >>' }),
    pdf({ pageSuffix: ' /Annots []' }),
    pdf({ pageSuffix: ' /Dur 5' }),
    pdf({ pageSuffix: ' /Trans << /S /Fly >>' }),
    pdf({ pageSuffix: ' /PresSteps <<>>' }),
    pdf({ pageSuffix: ' /Vendor << /Type /Action >>' }),
    pdf({ pageSuffix: ' /Vendor [<< /S /JavaScript /JS (survives) >>]' }),
  ];
  for (const source of hostile) assert.throws(() => writeIncrementalPdfNamedDestination(source, request), { code: 'UNSUPPORTED_INCREMENTAL_NAMED_DESTINATION_PDF' });
});

test('independent inspection rejects output or source tampering', () => {
  const source = pdf(); const output = writeIncrementalPdfNamedDestination(source, request).bytes;
  const changed = Buffer.from(output); changed[changed.length - 8] ^= 1;
  assert.throws(() => inspectIncrementalPdfNamedDestination(source, changed, request), { code: 'INVALID_INCREMENTAL_NAMED_DESTINATION_OUTPUT' });
  const mutated = Buffer.from(source); mutated[10] ^= 1;
  assert.throws(() => inspectIncrementalPdfNamedDestination(mutated, output, request), { code: 'UNSUPPORTED_INCREMENTAL_NAMED_DESTINATION_PDF' });
});

test('installed Poppler reports the named destination', async (context) => {
  if (spawnSync('pdfinfo', ['-v']).error) { context.skip('Poppler is unavailable.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'named-destination-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'named.pdf');
  await writeFile(path, writeIncrementalPdfNamedDestination(pdf({ stream: true }), request).bytes);
  const result = spawnSync('pdfinfo', ['-dests', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /chapter-one/u);
});
