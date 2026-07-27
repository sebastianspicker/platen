import { createHash } from 'node:crypto';

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Classic single-page passive PDF suitable for signature-container / redaction / form writers. */
export function classicPassivePdf({
  pages = 1,
  secret = 'TOPSECRET',
  width = 100,
  height = 100,
} = {}) {
  const pageRefs = [];
  const bodies = new Map();
  bodies.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = [];
  let next = 3;
  for (let page = 1; page <= pages; page += 1) {
    const pageObj = next;
    const contentObj = next + 1;
    const fontObj = next + 2;
    kids.push(`${pageObj} 0 R`);
    const stream = `BT /F1 12 Tf 10 80 Td (${page === 1 ? secret : `page-${page}`}) Tj ET`;
    const streamBytes = Buffer.from(`${stream}\n`, 'latin1');
    bodies.set(pageObj, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /CropBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`);
    bodies.set(contentObj, `<< /Length ${streamBytes.length} >>\nstream\n${stream}\nendstream`);
    bodies.set(fontObj, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    pageRefs.push(pageObj);
    next += 3;
  }
  bodies.set(2, `<< /Type /Pages /Count ${pages} /Kids [${kids.join(' ')}] >>`);

  const chunks = ['%PDF-1.7\n'];
  const offsets = new Map();
  for (const [number, body] of [...bodies.entries()].sort((a, b) => a[0] - b[0])) {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  }
  const size = Math.max(...bodies.keys()) + 1;
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let index = 1; index < size; index += 1) {
    chunks.push(`${String(offsets.get(index) ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

/** Two-page redaction fixture with independent resources (from full-page redaction tests). */
export function redactionFixture({ secret = 'secret', survivor = 'survivor' } = {}) {
  const streamObject = (payload) => {
    const bytes = Buffer.from(payload, 'latin1');
    return `<< /Length ${bytes.length + 1} >>\nstream\n${payload}\nendstream`;
  };
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 2 /Kids [3 0 R 6 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'],
    [4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [5, streamObject(`BT /F1 12 Tf 10 80 Td (${secret}) Tj ET`)],
    [6, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources << /Font << /F1 8 0 R >> >> /Contents 7 0 R >>'],
    [7, streamObject(`BT /F1 12 Tf 10 80 Td (${survivor}) Tj ET`)],
    [8, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ]);
  const chunks = ['%PDF-1.7\n'];
  const offsets = new Map();
  for (const [number, body] of bodies) {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  }
  const size = Math.max(...bodies.keys()) + 1;
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let index = 1; index < size; index += 1) chunks.push(`${String(offsets.get(index)).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

/** Signature-container admitted source (no Annots/AcroForm). */
export function signatureFixture() {
  const chunks = ['%PDF-1.7\n'];
  const offsets = new Map();
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>'],
    [4, '<< /Length 0 >>\nstream\n\nendstream'],
  ]);
  for (const [number, body] of bodies) {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 5\n0000000000 65535 f \n${[1, 2, 3, 4].map((n) => `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

/** Form-admitted source (two pages, no existing forms). */
export function formFixture() {
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>'],
    [4, '<< /Length 0 >>\nstream\n\nendstream'],
    [5, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 6 0 R >>'],
    [6, '<< /Length 0 >>\nstream\n\nendstream'],
  ]);
  const chunks = ['%PDF-1.7\n'];
  const offsets = new Map();
  for (const [number, body] of bodies) {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 7\n0000000000 65535 f \n${[1, 2, 3, 4, 5, 6].map((n) => `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

/** Single-page PDF with one unescaped Tj literal (admitted by text-edit writer). */
export function editableTextPdf(text = 'hello world') {
  const escaped = String(text).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\n`;
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
    [4, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`],
    [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ]);
  const chunks = ['%PDF-1.7\n'];
  const offsets = new Map();
  for (const [number, body] of bodies) {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

/** AEC measure admitted source with one passive annotation. */
export function aecFixture() {
  const annotation = '<< /Type /Annot /Subtype /Square /Rect [72 72 144 144] /F 4 /C [1 0 0] >>';
  const bodies = [
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 3 0 R /Annots 4 0 R >>',
    '<< /Type /Pages /MediaBox [0 0 612 792] /Count 1 /Kids [1 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '[5 0 R]',
    annotation,
    '<< /Type /Catalog /Pages 2 0 R >>',
  ];
  const chunks = ['%PDF-1.3\n'];
  const offsets = [0];
  bodies.forEach((body, index) => {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${bodies.length + 1} /Root 6 0 R /ID [<${'11'.repeat(16)}> <${'22'.repeat(16)}>] >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}
