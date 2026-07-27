import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectPdfAccessibilityTableSemantics, writePdfAccessibilityTableSemantics } from '../scripts/host/pdf-accessibility-table-semantics-writer.mjs';
import { normalizePdfAccessibilityTableSemantics, PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE } from '../scripts/host/pdf-accessibility-table-semantics-contract.mjs';

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function fixedReplacement(source, before, replacement) { assert.equal(Buffer.byteLength(replacement, 'latin1'), Buffer.byteLength(before, 'latin1')); const text = source.toString('latin1'); assert.equal(text.includes(before), true); return Buffer.from(text.replace(before, replacement), 'latin1'); }
function fixture() {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map(); const object = (number, body) => { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); };
  object(1, '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo 7 0 R >>'); object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'); object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /StructParents 0 >>');
  const stream = '/P <</MCID 0>> BDC\nq Q\nEMC\n/P <</MCID 1>> BDC\nq Q\nEMC\n/P <</MCID 2>> BDC\nq Q\nEMC\n/P <</MCID 3>> BDC\nq Q\nEMC\n'; offsets.set(4, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream\nendobj\n`);
  object(5, '<< /Type /Pages >>'); object(6, '<< /Type /StructTreeRoot /K [8 0 R] /ParentTree 15 0 R >>'); object(7, '<< /Marked true >>'); object(8, '<< /Type /StructElem /S /Table /P 6 0 R /K [9 0 R 10 0 R] >>'); object(9, '<< /Type /StructElem /S /TR /P 8 0 R /K [11 0 R 12 0 R] >>'); object(10, '<< /Type /StructElem /S /TR /P 8 0 R /K [13 0 R 14 0 R] >>');
  const cell = (role, parent, mcid) => `<< /Type /StructElem /S /${role} /P ${parent} 0 R /Pg 3 0 R /K [<< /Type /MCR /Pg 3 0 R /MCID ${mcid} >>] >>`; object(11, cell('TH', 9, 0)); object(12, cell('TH', 9, 1)); object(13, cell('TD', 10, 2)); object(14, cell('TD', 10, 3)); object(15, '<< /Nums [0 [11 0 R 12 0 R 13 0 R 14 0 R]] >>');
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 16\n0000000000 65535 f \n'); for (let number = 1; number <= 15; number += 1) chunks.push(`${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`); chunks.push(`trailer\n<< /Size 16 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); return Buffer.from(chunks.join(''), 'latin1');
}
function request(source, cells = null) { const value = { profile: PDF_ACCESSIBILITY_TABLE_SEMANTICS_PROFILE, sourceSha256: digest(source), table: { tableRef: { object: 8, generation: 0 }, cells: cells ?? [
  { id: 'h1', structRef: { object: 11, generation: 0 }, role: 'TH', row: 0, column: 0, page: 1, contentRef: { object: 4, generation: 0 }, mcid: 0, scope: 'column', headers: [], rowSpan: 1, colSpan: 1 },
  { id: 'h2', structRef: { object: 12, generation: 0 }, role: 'TH', row: 0, column: 1, page: 1, contentRef: { object: 4, generation: 0 }, mcid: 1, scope: 'column', headers: [], rowSpan: 1, colSpan: 1 },
  { id: 'd1', structRef: { object: 13, generation: 0 }, role: 'TD', row: 1, column: 0, page: 1, contentRef: { object: 4, generation: 0 }, mcid: 2, scope: null, headers: ['h1'], rowSpan: 1, colSpan: 1 },
  { id: 'd2', structRef: { object: 14, generation: 0 }, role: 'TD', row: 1, column: 1, page: 1, contentRef: { object: 4, generation: 0 }, mcid: 3, scope: null, headers: ['h2'], rowSpan: 1, colSpan: 1 },
 ] } }; return value; }

test('table semantics repairs exact scope, headers, and spans append-only', () => {
  const source = fixture(); const value = request(source); const first = writePdfAccessibilityTableSemantics(source, value); const second = writePdfAccessibilityTableSemantics(source, value);
  assert.deepEqual(first.bytes, second.bytes); assert.equal(first.bytes.subarray(0, source.length).equals(source), true); assert.equal(first.proof.cellCount, 4); assert.equal(first.proof.structureLinked, true); assert.deepEqual(inspectPdfAccessibilityTableSemantics(source, first.bytes, value), first.proof);
});

test('table semantics rejects stale, non-rectangular, forged, and hostile requests', () => {
  const source = fixture(); const value = request(source);
  assert.throws(() => writePdfAccessibilityTableSemantics(source, { ...value, sourceSha256: '0'.repeat(64) }), { code: 'UNSUPPORTED_PDF_ACCESSIBILITY_TABLE_SEMANTICS' });
  assert.throws(() => writePdfAccessibilityTableSemantics(source, request(source, value.table.cells.slice(0, 3))), { code: 'INVALID_PDF_ACCESSIBILITY_TABLE_SEMANTICS' });
  assert.throws(() => writePdfAccessibilityTableSemantics(source, request(source, value.table.cells.map((cell) => ({ ...cell, role: cell.role === 'TD' ? 'TH' : cell.role })))), { code: 'UNSUPPORTED_PDF_ACCESSIBILITY_TABLE_SEMANTICS' });
  const getter = { ...value }; Object.defineProperty(getter, 'sourceSha256', { enumerable: true, get() { throw new Error('getter'); } }); assert.throws(() => normalizePdfAccessibilityTableSemantics(getter), { code: 'INVALID_PDF_ACCESSIBILITY_TABLE_SEMANTICS' });
  const proxy = new Proxy(value.table.cells, {}); assert.throws(() => normalizePdfAccessibilityTableSemantics({ ...value, table: { ...value.table, cells: proxy } }), { code: 'INVALID_PDF_ACCESSIBILITY_TABLE_SEMANTICS' });
  const active = Buffer.from(source.toString('latin1').replace('/StructTreeRoot 6 0 R', '/StructTreeRoot 6 0 R /OpenAction 7 0 R'), 'latin1'); assert.throws(() => writePdfAccessibilityTableSemantics(active, request(active)), { code: 'UNSUPPORTED_PDF_ACCESSIBILITY_TABLE_SEMANTICS' });
  const action = Buffer.from(source.toString('latin1').replace('/StructTreeRoot 6 0 R', '/StructTreeRoot 6 0 R /A << /S /JavaScript >>'), 'latin1'); assert.throws(() => writePdfAccessibilityTableSemantics(action, request(action)), { code: 'UNSUPPORTED_PDF_ACCESSIBILITY_TABLE_SEMANTICS' });
  const duplicateMcid = Buffer.from(source.toString('latin1').replace('/MCID 3>>', '/MCID 2>>'), 'latin1'); assert.throws(() => writePdfAccessibilityTableSemantics(duplicateMcid, request(duplicateMcid)), { code: 'UNSUPPORTED_PDF_ACCESSIBILITY_TABLE_SEMANTICS' });
  const reassigned = value.table.cells.map((cell) => (cell.id === 'h1' ? { ...cell, row: 1 } : cell.id === 'd1' ? { ...cell, row: 0 } : cell)); assert.throws(() => writePdfAccessibilityTableSemantics(source, request(source, reassigned)), { code: 'UNSUPPORTED_PDF_ACCESSIBILITY_TABLE_SEMANTICS' });
  const built = writePdfAccessibilityTableSemantics(source, value); assert.throws(() => inspectPdfAccessibilityTableSemantics(source, Buffer.concat([built.bytes, Buffer.from('tamper')]), value), { code: 'INVALID_PDF_ACCESSIBILITY_TABLE_SEMANTICS_OUTPUT' });
});

test('table semantics rejects comment and string MCID decoys that match raw text', () => {
  const source = fixture(); const operator = '/P <</MCID 0>> BDC';
  const comment = fixedReplacement(source, operator, '%/MCID 0 >> BDC   ');
  assert.match(comment.toString('latin1'), /\/MCID\s+0\s*>>\s*BDC/u);
  assert.throws(() => writePdfAccessibilityTableSemantics(comment, request(comment)), { code: 'UNSUPPORTED_PDF_ACCESSIBILITY_TABLE_SEMANTICS' });
  const string = fixedReplacement(source, operator, '(/MCID 0 >> BDC)  ');
  assert.match(string.toString('latin1'), /\/MCID\s+0\s*>>\s*BDC/u);
  assert.throws(() => writePdfAccessibilityTableSemantics(string, request(string)), { code: 'UNSUPPORTED_PDF_ACCESSIBILITY_TABLE_SEMANTICS' });
});
