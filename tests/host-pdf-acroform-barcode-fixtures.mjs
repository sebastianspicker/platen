import { createHash } from 'node:crypto';

export function makeBarcodeFieldPdf({ catalogExtra = '', pageExtra = '', trailerExtra = '' } = {}) {
  const bodies = new Map([
    [1, `<< /Type /Catalog /Pages 2 0 R${catalogExtra} >>`],
    [2, '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>'],
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 4 0 R${pageExtra} >>`],
    [4, '<< /Length 0 >>\nstream\n\nendstream'],
    [5, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792] /Resources << >> /Contents 6 0 R >>'],
    [6, '<< /Length 0 >>\nstream\n\nendstream'],
  ]);
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  for (const [object, body] of bodies) { offsets.set(object, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${object} 0 obj\n${body}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push(`xref\n0 7\n0000000000 65535 f \n${[1, 2, 3, 4, 5, 6].map((object) => `${String(offsets.get(object)).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

export function barcodeFieldRequest(source, overrides = {}) {
  return { profile: 'local-pdf-acroform-barcode-v1', sourceSha256: createHash('sha256').update(source).digest('hex'), page: 1, fieldName: 'ShippingBarcode', rect: { x: 72, y: 640, width: 240, height: 48 }, symbology: 'code39-basic', payload: 'ABC-123', ...overrides };
}
