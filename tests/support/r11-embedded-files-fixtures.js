import { createHash } from 'node:crypto';
import { PDF_SPECIALIST_CONTENT_PROFILE } from '../../scripts/host/pdf-specialist-content-inventory.mjs';

function classicPdf(objects) {
  const chunks = [Buffer.from('%PDF-1.7\n', 'latin1')];
  const offsets = new Map();
  const maxObject = Math.max(...objects.keys());
  for (let id = 1; id <= maxObject; id += 1) {
    const body = objects.get(id);
    if (body === undefined) continue;
    offsets.set(id, Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${id} 0 obj\n${body}\nendobj\n`, 'latin1'));
  }
  const xrefOffset = Buffer.concat(chunks).length;
  const rows = [`xref\n0 ${maxObject + 1}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id <= maxObject; id += 1) {
    rows.push(offsets.has(id)
      ? `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`
      : '0000000000 00000 f \n');
  }
  chunks.push(Buffer.from(`${rows.join('')}trailer\n<< /Size ${maxObject + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

export function embeddedSource() {
  const embedded = 'R11-DATA';
  return classicPdf(new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R /Collection 9 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Annots [15 0 R] /Contents 5 0 R >>'],
    [5, '<< /Length 0 >>\nstream\n\nendstream'],
    [9, '<< /Type /Collection /Schema 20 0 R /View /T >>'],
    [13, '<< /Type /Filespec /F (private.txt) /EF << /F 19 0 R >> >>'],
    [15, '<< /Type /Annot /Subtype /FileAttachment /FS 13 0 R /Rect [0 0 1 1] >>'],
    [19, `<< /Type /EmbeddedFile /Length ${embedded.length} >>\nstream\n${embedded}\nendstream`],
    [20, '<< /Name << /Type /CollectionField /N (Description) >> >>'],
  ]));
}

export function malformedEmbeddedSource() {
  return classicPdf(new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Annots [15 0 R] /Contents 5 0 R >>'],
    [5, '<< /Length 0 >>\nstream\n\nendstream'],
    [15, '<< /Type /Annot /Subtype /FileAttachment /FS 13 0 R /Rect [0 0 1 1] >>'],
    [13, '<< /Type /Filespec /F (broken.txt) /EF << /F 13 0 R >> >>'],
  ]));
}

export function requestFor(source) {
  return {
    profile: PDF_SPECIALIST_CONTENT_PROFILE,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
  };
}

export function digest(source) {
  return createHash('sha256').update(source).digest('hex');
}
