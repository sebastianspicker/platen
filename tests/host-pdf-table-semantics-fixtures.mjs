import { createHash } from 'node:crypto';
export function makeTablePdf() {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map(); const object = (number, body) => { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); };
  object(1, '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo 7 0 R >>'); object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'); object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /StructParents 0 >>');
  const stream = '/P <</MCID 0>> BDC\nq Q\nEMC\n/P <</MCID 1>> BDC\nq Q\nEMC\n/P <</MCID 2>> BDC\nq Q\nEMC\n/P <</MCID 3>> BDC\nq Q\nEMC\n'; offsets.set(4, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream\nendobj\n`);
  object(5, '<< /Type /Pages >>'); object(6, '<< /Type /StructTreeRoot /K [8 0 R] /ParentTree 15 0 R >>'); object(7, '<< /Marked true >>'); object(8, '<< /Type /StructElem /S /Table /P 6 0 R /K [9 0 R 10 0 R] >>'); object(9, '<< /Type /StructElem /S /TR /P 8 0 R /K [11 0 R 12 0 R] >>'); object(10, '<< /Type /StructElem /S /TR /P 8 0 R /K [13 0 R 14 0 R] >>');
  const cell = (role, parent, mcid) => `<< /Type /StructElem /S /${role} /P ${parent} 0 R /Pg 3 0 R /K [<< /Type /MCR /Pg 3 0 R /MCID ${mcid} >>] >>`; object(11, cell('TH', 9, 0)); object(12, cell('TH', 9, 1)); object(13, cell('TD', 10, 2)); object(14, cell('TD', 10, 3)); object(15, '<< /Nums [0 [11 0 R 12 0 R 13 0 R 14 0 R]] >>');
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 16\n0000000000 65535 f \n'); for (let number = 1; number <= 15; number += 1) chunks.push(`${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`); chunks.push(`trailer\n<< /Size 16 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); return Buffer.from(chunks.join(''), 'latin1');
}
export function tableRequest(source) {
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  return { profile: 'local-accessibility-table-semantics-v1', sourceSha256, table: { tableRef: { object: 8, generation: 0 }, cells: [
    { id: 'h1', structRef: { object: 11, generation: 0 }, role: 'TH', row: 0, column: 0, page: 1, contentRef: { object: 4, generation: 0 }, mcid: 0, scope: 'column', headers: [], rowSpan: 1, colSpan: 1 },
    { id: 'h2', structRef: { object: 12, generation: 0 }, role: 'TH', row: 0, column: 1, page: 1, contentRef: { object: 4, generation: 0 }, mcid: 1, scope: 'column', headers: [], rowSpan: 1, colSpan: 1 },
    { id: 'd1', structRef: { object: 13, generation: 0 }, role: 'TD', row: 1, column: 0, page: 1, contentRef: { object: 4, generation: 0 }, mcid: 2, scope: null, headers: ['h1'], rowSpan: 1, colSpan: 1 },
    { id: 'd2', structRef: { object: 14, generation: 0 }, role: 'TD', row: 1, column: 1, page: 1, contentRef: { object: 4, generation: 0 }, mcid: 3, scope: null, headers: ['h2'], rowSpan: 1, colSpan: 1 },
  ] } };
}
