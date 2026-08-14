import { createHash } from 'node:crypto';

function pdfEscapeName(name) {
  return `/${name.replace(/[^!-$&'*-.0-;=?-Z\\^-z|~]/g, (ch) => `#${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
}

function pdfLiteral(text) {
  return `(${String(text).replace(/[\\()]/g, (ch) => `\\${ch}`)})`;
}

function pdfHexString(bytes) {
  return `<${Buffer.from(bytes).toString('hex')}>`;
}

function writeObjects(parts, objects) {
  const offsets = new Map();
  let offset = Buffer.byteLength(parts[0], 'latin1');
  for (const [id, body] of objects) {
    offsets.set(id, offset);
    const chunk = `${id} 0 obj\n${body}\nendobj\n`;
    parts.push(chunk);
    offset += Buffer.byteLength(chunk, 'latin1');
  }
  return { offsets, offset };
}

function buildEmbeddedFileObjects(normalized, alloc, objects) {
  const kids = [];
  for (const file of normalized) {
    const streamId = alloc();
    const filespecId = alloc();
    objects.set(streamId, `<< /Type /EmbeddedFile /Length ${file.bytes.length} >>\nstream\n${file.bytes.toString('latin1')}\nendstream`);
    objects.set(filespecId, `<< /Type /Filespec /F ${pdfLiteral(file.name)} /UF ${pdfLiteral(file.name)} /Desc ${pdfLiteral(file.description)} /EF << /F ${streamId} 0 R >> >>`);
    kids.push(`${pdfLiteral(file.name)} ${filespecId} 0 R`);
  }
  return kids;
}

export function assemblePortfolioPdf({ files, title, view, schema }) {
  const objects = new Map();
  let nextId = 1;
  const alloc = () => nextId++;

  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const collectionId = alloc();
  const namesId = alloc();
  const efTreeId = alloc();

  const content = 'BT /F1 12 Tf 72 720 Td (PDF Portfolio) Tj ET\n';
  objects.set(contentId, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);

  const schemaEntries = schema.map((field, index) => {
    const fieldId = alloc();
    objects.set(fieldId, `<< /Type /CollectionField /Subtype /S /N ${pdfLiteral(field.title)} /O ${index + 1} >>`);
    return `${pdfEscapeName(field.key)} ${fieldId} 0 R`;
  }).join(' ');

  objects.set(collectionId, `<< /Type /Collection /View /${view} /Schema << ${schemaEntries} >> >>`);
  const nameKids = buildEmbeddedFileObjects(files, alloc, objects);
  objects.set(efTreeId, `<< /Names [${nameKids.join(' ')}] >>`);
  objects.set(namesId, `<< /EmbeddedFiles ${efTreeId} 0 R >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /Names ${namesId} 0 R /Collection ${collectionId} 0 R /PageMode /UseAttachments >>`);

  const parts = ['%PDF-1.7\n'];
  const { offsets, offset } = writeObjects(parts, [...objects.entries()].sort((a, b) => a[0] - b[0]));
  const xrefStart = offset;
  const size = nextId;
  const xrefLines = [`xref\n0 ${size}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id < size; id += 1) {
    xrefLines.push(`${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  const xref = Buffer.from(xrefLines.join(''), 'latin1');
  parts.push(xref);
  const idBytes = createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1')))).digest().subarray(0, 16);
  const trailer = Buffer.from(
    `trailer\n<< /Size ${size} /Root ${catalogId} 0 R /ID [${pdfHexString(idBytes)} ${pdfHexString(idBytes)}] >>\nstartxref\n${xrefStart}\n%%EOF\n`,
    'latin1',
  );
  parts.push(trailer);
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))));
}
