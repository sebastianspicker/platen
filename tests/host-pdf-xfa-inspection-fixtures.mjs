import { createHash } from 'node:crypto';

export function makeXfaInspectionPdf({ catalogXfa = false, acroFormXfa = false, xfaValue = '5 0 R', indirectAcroForm = false, content = 'q\nQ\n' } = {}) {
  const acroForm = `<< /Fields []${acroFormXfa ? ` /XFA ${xfaValue}` : ''} >>`;
  const objects = new Map([
    [1, `<< /Type /Catalog /Pages 2 0 R${catalogXfa ? ` /XFA ${xfaValue}` : ''}${indirectAcroForm ? ' /AcroForm 5 0 R' : ` /AcroForm ${acroForm}`} >>`],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>'],
    [4, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`],
  ]);
  if (catalogXfa || acroFormXfa || indirectAcroForm) objects.set(5, indirectAcroForm ? acroForm : '<< /Length 7 >>\nstream\npayload\nendstream');
  const ordered = [...objects].sort(([left], [right]) => left - right);
  const maximum = Math.max(...ordered.map(([object]) => object));
  const chunks = ['%PDF-1.7\n% /XFA comment decoy\n']; const offsets = new Map();
  for (const [object, body] of ordered) {
    offsets.set(object, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${object} 0 obj\n${body}\nendobj\n`);
  }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${maximum + 1}\n0000000000 65535 f \n`);
  for (let object = 1; object <= maximum; object += 1) chunks.push(offsets.has(object) ? `${String(offsets.get(object)).padStart(10, '0')} 00000 n \n` : '0000000000 00000 f \n');
  chunks.push(`trailer\n<< /Size ${maximum + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

export function xfaInspectionRequest(source, overrides = {}) {
  return { profile: 'local-pdf-xfa-presence-inspection-v1', sourceSha256: createHash('sha256').update(source).digest('hex'), ...overrides };
}
