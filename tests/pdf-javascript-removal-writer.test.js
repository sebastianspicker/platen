import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPdfJavaScriptRemoval, verifyPdfJavaScriptRemoval } from '../scripts/host/pdf-javascript-removal-writer.mjs';
import { PDF_JAVASCRIPT_REMOVAL_PROFILE } from '../scripts/host/pdf-javascript-removal-contract.mjs';
import { parseClassicPdfStructure, resolveClassicPdfObject } from '../scripts/host/pdf-classic-structure.mjs';

function classic(objects) {
  let body = '%PDF-1.7\n'; const offsets = new Map();
  for (const [number, value] of objects) { offsets.set(number, Buffer.byteLength(body, 'latin1')); body += `${number} 0 obj\n${value}\nendobj\n`; }
  const at = Buffer.byteLength(body, 'latin1'); const numbers = [...objects.keys()].sort((a, b) => a - b);
  body += `xref\n0 ${Math.max(...numbers) + 1}\n0000000000 65535 f \n`;
  for (const number of numbers) body += `${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${Math.max(...numbers) + 1} /Root 1 0 R /ID [<000102030405060708090A0B0C0D0E0F> <101112131415161718191A1B1C1D1E1F>] >>\nstartxref\n${at}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function openAction({ extraCatalog = '', action = '<< /S /JavaScript /JS (REMOVE-ME-OPEN) >>', extra = '' } = {}) {
  return classic(new Map([[1, `<< /Type /Catalog /Pages 2 0 R /OpenAction 3 0 R${extraCatalog} >>`], [2, '<< /Type /Pages /Count 1 /Kids [4 0 R] >>'], [3, action], [4, extra || '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>']]));
}

function namesAction({ name = 'boot', script = 'REMOVE-ME-NAMES' } = {}) {
  return classic(new Map([[1, '<< /Type /Catalog /Pages 2 0 R /Names << /JavaScript 3 0 R >> >>'], [2, '<< /Type /Pages /Count 1 /Kids [5 0 R] >>'], [3, `<< /Names [(${name}) 4 0 R] >>`], [4, `<< /S /JavaScript /JS (${script}) >>`], [5, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>']]));
}

const request = Object.freeze({ profile: PDF_JAVASCRIPT_REMOVAL_PROFILE });

test('removes the sole indirect Catalog OpenAction and compacts historical script bytes', () => {
  const source = openAction(); const result = buildPdfJavaScriptRemoval(source, request);
  assert.equal(result.bytes.includes(Buffer.from('REMOVE-ME-OPEN', 'latin1')), false);
  assert.equal(result.proof.closedClassicRevision, true);
  assert.equal(result.proof.javascriptSurfacesAbsent, true);
  const output = parseClassicPdfStructure(result.bytes); const catalog = resolveClassicPdfObject(output, output.root).value;
  assert.equal(output.revisions.length, 1); assert.equal(catalog.entries.has('OpenAction'), false);
  assert.throws(() => resolveClassicPdfObject(output, { type: 'ref', object: 3, generation: 0 }));
  assert.deepEqual(verifyPdfJavaScriptRemoval({ sourceBytes: source, outputBytes: result.bytes, request, expectedRemoval: result }), result.proof);
});

test('removes the sole direct Catalog Names JavaScript name-tree and action', () => {
  const source = namesAction(); const result = buildPdfJavaScriptRemoval(source, request); const output = parseClassicPdfStructure(result.bytes);
  assert.equal(result.bytes.includes(Buffer.from('REMOVE-ME-NAMES', 'latin1')), false);
  assert.equal(resolveClassicPdfObject(output, output.root).value.entries.has('Names'), false);
  for (const number of [3, 4]) assert.throws(() => resolveClassicPdfObject(output, { type: 'ref', object: number, generation: 0 }));
});

test('fails closed for unsupported loci, shared targets, signatures, streams, and tampering', () => {
  const cases = [
    openAction({ extraCatalog: ' /AA << >>' }),
    openAction({ action: '<< /S /JavaScript /JS (x) /Next 4 0 R >>' }),
    openAction({ extra: '<< /Alias 3 0 R >>' }),
    openAction({ extraCatalog: ' /Names << /JavaScript 3 0 R >>' }),
    openAction({ extra: '<< /Type /Sig >>' }),
    openAction({ extra: '<< /A << /S /SubmitForm >> >>' }),
    openAction({ extra: '<< /Vendor << /Type /Action /S /VendorExecute /Payload (survives) >> >>' }),
    openAction({ extra: '<< /Vendor << /S /VendorExecute /Payload (survives) >> >>' }),
    classic(new Map([[1, '<< /Type /Catalog /Pages 2 0 R /OpenAction 3 0 R >>'], [2, '<< /Type /Pages /Count 0 /Kids [] >>'], [3, '<< /S /JavaScript /JS (x) >>\nstream\nx\nendstream']])),
  ];
  for (const source of cases) assert.throws(() => buildPdfJavaScriptRemoval(source, request), { code: 'INVALID_PDF_JAVASCRIPT_REMOVAL' });
  const source = openAction(); const result = buildPdfJavaScriptRemoval(source, request); const tampered = Buffer.from(result.bytes); tampered[0] ^= 1;
  assert.throws(() => verifyPdfJavaScriptRemoval({ sourceBytes: source, outputBytes: tampered, request, expectedRemoval: result }), { code: 'INVALID_PDF_JAVASCRIPT_REMOVAL' });
  const shared = Buffer.from(new SharedArrayBuffer(source.length)); source.copy(shared);
  assert.throws(() => buildPdfJavaScriptRemoval(shared, request), { code: 'INVALID_PDF_JAVASCRIPT_REMOVAL' });
  assert.throws(() => buildPdfJavaScriptRemoval(source, {}), { code: 'INVALID_PDF_JAVASCRIPT_REMOVAL' });
});

test('enforces the direct script and flat name-tree byte ceilings', () => {
  const cases = [
    openAction({ action: '<< /S /JavaScript /JS () >>' }),
    openAction({ action: `<< /S /JavaScript /JS (${'x'.repeat((64 * 1024) + 1)}) >>` }),
    namesAction({ name: '' }),
    namesAction({ name: 'n'.repeat(1_025) }),
    namesAction({ script: '' }),
    namesAction({ script: 'x'.repeat((64 * 1024) + 1) }),
  ];
  for (const source of cases) {
    assert.throws(
      () => buildPdfJavaScriptRemoval(source, request),
      { code: 'INVALID_PDF_JAVASCRIPT_REMOVAL' },
    );
  }
  assert.equal(buildPdfJavaScriptRemoval(namesAction({ name: 'n'.repeat(1_024) }), request).proof.removedLocus, 'names');
  assert.equal(buildPdfJavaScriptRemoval(openAction({ action: `<< /S /JavaScript /JS (${'x'.repeat(64 * 1024)}) >>` }), request).proof.removedLocus, 'open-action');
});

test('preserves opaque direct-length page content streams while removing JavaScript', () => {
  const source = classic(new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R /OpenAction 3 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [4 0 R] >>'],
    [3, '<< /S /JavaScript /JS (REMOVE-ME-STREAM-DOC) >>'],
    [4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 5 0 R >>'],
    [5, '<< /Length 3 >>\nstream\nq Q\nendstream'],
  ]));
  const result = buildPdfJavaScriptRemoval(source, request);
  assert.equal(result.bytes.includes(Buffer.from('REMOVE-ME-STREAM-DOC', 'latin1')), false);
  const output = parseClassicPdfStructure(result.bytes);
  const stream = resolveClassicPdfObject(output, { type: 'ref', object: 5, generation: 0 });
  assert.equal(result.bytes.subarray(stream.streamStart, stream.streamStart + stream.streamLength).toString('latin1'), 'q Q');
});

test('installed Poppler reopens and renders the compact JavaScript-free output', async (context) => {
  if (['pdfinfo', 'pdftocairo'].some((tool) => spawnSync(tool, ['-v']).error)) { context.skip('Poppler is unavailable.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'pdf-javascript-removal-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'clean.pdf'); await writeFile(path, buildPdfJavaScriptRemoval(openAction(), request).bytes);
  for (const [tool, args] of [['pdfinfo', [path]], ['pdftocairo', ['-png', '-singlefile', path, join(directory, 'page')]]]) {
    const result = spawnSync(tool, args, { encoding: 'utf8' }); assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
  }
});
