import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseClassicPdfStructure, resolveClassicPdfObject, parsePdfStructure, resolvePdfObject } from '../scripts/host/pdf-classic-structure.mjs';
import { verifyClosedClassicPdfOutput } from '../scripts/host/pdf-classic-closed-output.mjs';
import { buildPdfCompactRewrite } from '../scripts/host/pdf-compact-rewrite.mjs';
import { makeObjectStreamPdf } from './support/pdf-xref-stream-fixture.js';

const ref = (object, generation = 0) => Object.freeze({ type: 'ref', object, generation });
const execFileAsync = promisify(execFile);

function makeBareReferenceObjectMemberPdf(member = '4 0 R', { catalogReference = true, rewriteInfo = true } = {}) {
  const source = makeObjectStreamPdf({ filtered: false });
  const text = source.toString('latin1');
  assert.match(text, /<< \/Type \/Catalog \/Pages 4 0 R >>/u);
  assert.match(text, /<< \/Title \(Old\) >>/u);
  assert.match(text, /\/Info 2 0 R/u);
  assert.ok(Buffer.byteLength(member, 'latin1') <= 18);
  const catalog = catalogReference
    ? text.replace('<< /Type /Catalog /Pages 4 0 R >>', '<< /Type /Catalog /Pages 2 0 R >>') : text;
  const info = rewriteInfo ? catalog.replace('/Info 2 0 R', '/Info 4 0 R') : catalog;
  return Buffer.from(info.replace('<< /Title (Old) >>', member.padEnd(18, ' ')), 'latin1');
}

test('generic resolver and compact rewrite preserve a bare-reference object-stream member', () => {
  const source = makeBareReferenceObjectMemberPdf();
  const structure = parsePdfStructure(source);
  assert.equal(structure.effective.get(2).status, 'c');
  assert.deepEqual(resolvePdfObject(structure, ref(2)).value, { type: 'ref', object: 4, generation: 0 });
  assert.equal(resolvePdfObject(structure, ref(4)).value.type, 'dict');

  const rewrite = buildPdfCompactRewrite(source);
  assert.equal(verifyClosedClassicPdfOutput(rewrite.bytes).closed, true);
  const output = parseClassicPdfStructure(rewrite.bytes);
  assert.deepEqual(resolveClassicPdfObject(output, ref(2)).value, { type: 'ref', object: 4, generation: 0 });
  assert.equal(resolveClassicPdfObject(output, ref(4)).value.type, 'dict');
});

test('bare-reference object-stream members retain bounded dangling and control failures', () => {
  for (const member of ['99 0 R', '7 0 R']) {
    const source = makeBareReferenceObjectMemberPdf(member);
    const structure = parsePdfStructure(source);
    assert.equal(resolvePdfObject(structure, ref(2)).value.type, 'ref');
    assert.throws(() => buildPdfCompactRewrite(source), { code: 'INVALID_PDF_COMPACT_REWRITE' });
  }
});

test('installed Poppler accepts a bare-reference object-stream member', async (context) => {
  const tools = ['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo'];
  try { await Promise.all(tools.map((path) => access(path))); } catch { context.skip('The fixed Poppler toolchain is unavailable.'); return; }
  const source = makeBareReferenceObjectMemberPdf('4 0 R', { catalogReference: false, rewriteInfo: false });
  const directory = await mkdtemp(join(tmpdir(), 'pdf-bare-reference-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.pdf');
  await writeFile(sourcePath, source);
  const info = await execFileAsync('/opt/homebrew/bin/pdfinfo', [sourcePath]);
  assert.match(info.stdout, /^Pages:\s+1$/mu);
  await execFileAsync('/opt/homebrew/bin/pdftotext', [sourcePath, '-']);
  const renderRoot = join(directory, 'render');
  await execFileAsync('/opt/homebrew/bin/pdftocairo', ['-png', '-singlefile', '-f', '1', '-l', '1', sourcePath, renderRoot]);
  await access(`${renderRoot}.png`);
});
