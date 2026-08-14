import { createHash } from 'node:crypto';
export function makeTextReflowPdf({ streamOverride = null, catalogExtra = '' } = {}) {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map(); const object = (number, body) => { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); };
  object(1, `<< /Type /Catalog /Pages 2 0 R${catalogExtra} >>`); object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'); object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>');
  const stream = streamOverride ?? 'BT\n/F1 12 Tf\n72 720 Td\n(Alpha beta          ) Tj\nT*\n(gamma delta         ) Tj\nT*\n(                    ) Tj\nET\n'; offsets.set(4, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream\nendobj\n`); object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const xref = Buffer.byteLength(chunks.join(''), 'latin1'); chunks.push('xref\n0 6\n0000000000 65535 f \n'); for (let number = 1; number <= 5; number += 1) chunks.push(`${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`); chunks.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); return Buffer.from(chunks.join(''), 'latin1');
}
export function textReflowRequest(source, overrides = {}) {
  const original = 'Alpha beta gamma delta';
  return { profile: 'local-pdf-text-reflow-v1', sourceSha256: createHash('sha256').update(source).digest('hex'), page: 1, streamRef: { object: 4, generation: 0 }, lineTokenIndices: [7, 10, 13], lineWidth: 20, originalTextSha256: createHash('sha256').update(original, 'ascii').digest('hex'), replacementText: 'Alpha beta gamma delta epsilon', ...overrides };
}
