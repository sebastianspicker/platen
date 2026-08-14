import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPdfCompactRewrite, verifyPdfCompactRewrite } from '../scripts/host/pdf-compact-rewrite.mjs';
import { buildPdfCompactRewrite as exportedBuildPdfCompactRewrite } from '../scripts/host/pdf-service.mjs';
import { planPdfObjectTransaction } from '../scripts/host/pdf-classic-object-transaction.mjs';
import { parseClassicPdfStructure, parsePdfStructure, resolveClassicPdfObject } from '../scripts/host/pdf-classic-structure.mjs';
import { verifyClosedClassicPdfOutput } from '../scripts/host/pdf-classic-closed-output.mjs';
import { makeObjectStreamPdf, makeXrefStreamPdf } from './support/pdf-xref-stream-fixture.js';

function classic(objects, { root = '1 0 R', info = '', id = '' } = {}) {
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (const [number, value] of objects) { offsets[number] = Buffer.byteLength(body, 'latin1'); body += `${number} 0 obj\n${value}\nendobj\n`; }
  const xref = Buffer.byteLength(body, 'latin1'); const numbers = [...objects.keys()].sort((a, b) => a - b);
  body += 'xref\n0 1\n0000000000 65535 f \n';
  for (const number of numbers) body += `${number} 1\n${String(offsets[number]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${Math.max(...numbers) + 1} /Root ${root}${info}${id} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const ref = (object) => Object.freeze({ type: 'ref', object, generation: 0 });
const dict = (entries) => Object.freeze({ type: 'dict', entries: new Map(entries) });
const text = (value) => Object.freeze({ type: 'string', bytes: Buffer.from(value, 'latin1') });

test('compact rewrite is deterministic, closes xref streams and expands object streams', () => {
  assert.equal(exportedBuildPdfCompactRewrite, buildPdfCompactRewrite);
  for (const source of [makeXrefStreamPdf(), makeObjectStreamPdf({ filtered: true, compressedCatalog: true })]) {
    const first = buildPdfCompactRewrite(source); const second = buildPdfCompactRewrite(Buffer.from(source));
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(verifyPdfCompactRewrite({ sourceBytes: source, outputBytes: first.bytes, expectedRewrite: first }).closed.closed, true);
    assert.throws(() => verifyPdfCompactRewrite({ sourceBytes: source, outputBytes: first.bytes }), { code: 'INVALID_PDF_COMPACT_REWRITE' });
    assert.equal(verifyClosedClassicPdfOutput(first.bytes).closed, true);
    assert.equal(first.bytes.includes(Buffer.from('/ObjStm', 'latin1')), false);
    const output = parseClassicPdfStructure(first.bytes);
    assert.equal(output.finalSize, 7);
    assert.equal(resolveClassicPdfObject(output, output.root).value.entries.get('Type').value, 'Catalog');
  }
});

test('compact rewrite removes incremental history and retains only the effective graph', () => {
  const base = classic(new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 0 /Kids [] >>'],
    [3, '<< /Title (Old) >>'],
    [4, '<< /Secret (PRIOR-RESIDUE) >>'],
  ]), { info: ' /Info 3 0 R', id: ' /ID [<1122> <3344>]' });
  const sourceStructure = parsePdfStructure(base);
  const changingId = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const plan = planPdfObjectTransaction({
    sourceBytes: base, sourceStructure,
    updates: [{ reference: ref(3), value: dict([['Title', text('Latest')]]) }],
    additions: [], info: { kind: 'preserve' }, changingId,
  });
  const source = Buffer.concat([base, plan.revision.bytes]);
  assert.equal(parsePdfStructure(source).revisions.length, 2);
  const rewrite = buildPdfCompactRewrite(source); const output = parseClassicPdfStructure(rewrite.bytes);
  assert.equal(output.revisions.length, 1);
  assert.equal(output.revisions[0].trailer.has('Prev'), false);
  assert.equal(rewrite.bytes.includes(Buffer.from('(Old)', 'latin1')), false);
  assert.equal(rewrite.bytes.includes(Buffer.from('PRIOR-RESIDUE', 'latin1')), false);
  assert.deepEqual(output.id.map((entry) => entry.toString('hex')), ['1122', changingId.toString('hex')]);
  assert.equal(resolveClassicPdfObject(output, output.info).value.entries.get('Title').bytes.toString('latin1'), 'Latest');
});

test('compact rewrite preserves an admitted PDF 2.0 version', () => {
  const source = Buffer.from(makeXrefStreamPdf().toString('latin1').replace('%PDF-1.7', '%PDF-2.0'), 'latin1');
  assert.match(buildPdfCompactRewrite(source).bytes.toString('latin1', 0, 9), /^%PDF-2\.0/u);
});

test('compact rewrite preserves graph identity, binary payloads and trailer IDs while discarding unreachable bytes', () => {
  const payload = Buffer.from([0, 255, 10, 37, 1]);
  const stream = `<< /Length ${payload.length} /Note (SECRET-LIVE) >>\nstream\n${payload.toString('latin1')}\nendstream`;
  const source = classic(new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R /Loop 4 0 R >>'], [2, '<< /Type /Pages /Count 0 /Kids [] >>'],
    [3, '<< /Title (SECRET-UNREACHABLE) >>'], [4, `<< /Back 1 0 R /Payload 5 0 R >>`], [5, stream],
  ]), { id: ' /ID [<1122> <3344>]' });
  const rewrite = buildPdfCompactRewrite(source); const output = parseClassicPdfStructure(rewrite.bytes);
  assert.equal(rewrite.bytes.includes(Buffer.from('SECRET-UNREACHABLE', 'latin1')), false);
  assert.deepEqual(output.id.map((entry) => entry.toString('hex')), ['1122', '3344']);
  const parsed = resolveClassicPdfObject(output, { type: 'ref', object: 5, generation: 0 });
  assert.deepEqual(rewrite.bytes.subarray(parsed.streamStart, parsed.streamStart + parsed.streamLength), payload);
  assert.equal(output.effective.has(3), false);
});

test('compact rewrite rejects signatures, controls, dangling references and forged or mutated descriptors', () => {
  const cases = [
    classic(new Map([[1, '<< /Type /Catalog /Pages 2 0 R /X 9 0 R >>'], [2, '<< /Type /Pages /Count 0 /Kids [] >>']])),
    classic(new Map([[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Count 0 /Kids [] /ByteRange [0 1] >>']])),
    classic(new Map([[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Count 0 /Kids [] /Signature 3 0 R >>'], [3, '<< /Type /Sig >>']])),
    classic(new Map([[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Count 0 /Kids [] /Field 3 0 R >>'], [3, '<< /FT /Sig >>']])),
    classic(new Map([[1, '<< /Type /Catalog /Pages 2 0 R /Control 3 0 R >>'], [2, '<< /Type /Pages /Count 0 /Kids [] >>'], [3, '<< /Type /XRef >>']])),
    classic(new Map([[1, '<< /Type /Catalog /Pages 2 0 R /Control 3 0 R >>'], [2, '<< /Type /Pages /Count 0 /Kids [] >>'], [3, '<< /Type /ObjStm >>']])),
  ];
  for (const source of cases) assert.throws(() => buildPdfCompactRewrite(source), { code: 'INVALID_PDF_COMPACT_REWRITE' });
  const source = makeXrefStreamPdf(); const rewrite = buildPdfCompactRewrite(source); const forged = Object.freeze({ ...rewrite });
  assert.throws(() => verifyPdfCompactRewrite({ sourceBytes: source, outputBytes: rewrite.bytes, expectedRewrite: forged }), { code: 'INVALID_PDF_COMPACT_REWRITE' });
  rewrite.bytes[0] = 0;
  assert.throws(() => verifyPdfCompactRewrite({ sourceBytes: source, outputBytes: rewrite.bytes, expectedRewrite: rewrite }), { code: 'INVALID_PDF_COMPACT_REWRITE' });
  const mutableSource = Buffer.from(source); const stable = buildPdfCompactRewrite(mutableSource); mutableSource[0] = 0;
  assert.throws(() => verifyPdfCompactRewrite({ sourceBytes: mutableSource, outputBytes: stable.bytes, expectedRewrite: stable }), { code: 'INVALID_PDF_COMPACT_REWRITE' });
  const shared = Buffer.from(new SharedArrayBuffer(source.length)); source.copy(shared);
  assert.throws(() => buildPdfCompactRewrite(shared), { code: 'INVALID_PDF_COMPACT_REWRITE' });
});

test('compact rewrite enforces the reachable object limit before output allocation', () => {
  const objects = new Map([[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Count 0 /Kids [] /Next 3 0 R >>']]);
  for (let number = 3; number <= 10_002; number += 1) objects.set(number, number === 10_002 ? '<< >>' : `<< /Next ${number + 1} 0 R >>`);
  assert.throws(() => buildPdfCompactRewrite(classic(objects)), { code: 'PDF_COMPACT_REWRITE_LIMIT_EXCEEDED' });
});

test('installed Poppler reads and renders compact output', async (context) => {
  const tools = ['pdfinfo', 'pdftotext', 'pdftocairo'];
  if (tools.some((tool) => spawnSync(tool, ['-v']).error)) { context.skip('Poppler is unavailable.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'pdf-compact-rewrite-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'compact.pdf'); const output = buildPdfCompactRewrite(makeXrefStreamPdf()).bytes;
  await writeFile(path, output);
  for (const [tool, args] of [['pdfinfo', [path]], ['pdftotext', [path, '-']], ['pdftocairo', ['-png', '-singlefile', path, join(directory, 'page')]]]) {
    const result = spawnSync(tool, args, { encoding: 'utf8' }); assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
  }
});
