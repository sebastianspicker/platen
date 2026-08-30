/**
 * Classic PDF builders for document-authoring professional claims:
 * named destinations, OCG layers, watermarks, backgrounds, metadata Info.
 */
import { createHash } from 'node:crypto';

function pdfLiteral(text) {
  return `(${String(text).replace(/[\\()]/g, (ch) => `\\${ch}`)})`;
}

function finalize(objects, catalogId, nextId, infoId = null) {
  const parts = ['%PDF-1.7\n%âãÏÓ\n'];
  const offsets = new Map();
  let offset = Buffer.byteLength(parts[0], 'latin1');
  for (const [id, body] of [...objects.entries()].sort((a, b) => a[0] - b[0])) {
    offsets.set(id, offset);
    const chunk = `${id} 0 obj\n${body}\nendobj\n`;
    parts.push(chunk);
    offset += Buffer.byteLength(chunk, 'latin1');
  }
  const xrefStart = offset;
  const size = nextId;
  const xrefLines = [`xref\n0 ${size}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id < size; id += 1) {
    xrefLines.push(`${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  parts.push(xrefLines.join(''));
  const infoPart = infoId ? ` /Info ${infoId} 0 R` : '';
  parts.push(`trailer\n<< /Size ${size} /Root ${catalogId} 0 R${infoPart} >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.from(parts.join(''), 'latin1');
}

/** Named destinations tree under Catalog /Names /Dests. */
export function writeClassicNamedDestinationsPdf({
  destinations = [{ name: 'Chapter1', page: 1 }, { name: 'Chapter2', page: 2 }],
  width = 612,
  height = 792,
} = {}) {
  const dests = destinations.slice(0, 50);
  const pageCount = Math.max(1, ...dests.map((d) => Number(d.page) || 1), dests.length);
  const objects = new Map();
  let nextId = 1;
  const alloc = () => nextId++;
  const catalogId = alloc();
  const pagesId = alloc();
  const fontId = alloc();
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  for (let i = 0; i < pageCount; i += 1) {
    const contentId = alloc();
    const pageId = alloc();
    pageIds.push(pageId);
    const content = `BT /F1 12 Tf 72 720 Td ${pdfLiteral(`Dest host page ${i + 1}`)} Tj ET\n`;
    objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
    objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /CropBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
  }
  objects.set(pagesId, `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);

  // Dests name tree: /Names [ (name) [ page /XYZ ... ] ... ]
  const namePairs = [];
  for (const dest of dests) {
    const pageIndex = Math.max(0, Math.min(pageCount - 1, (Number(dest.page) || 1) - 1));
    const pageId = pageIds[pageIndex];
    namePairs.push(`${pdfLiteral(String(dest.name).slice(0, 64))} [ ${pageId} 0 R /XYZ 0 ${height} 0 ]`);
  }
  const destsId = alloc();
  objects.set(destsId, `<< /Names [ ${namePairs.join(' ')} ] >>`);
  const namesId = alloc();
  objects.set(namesId, `<< /Dests ${destsId} 0 R >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /Names ${namesId} 0 R /Dests ${destsId} 0 R >>`);

  const bytes = finalize(objects, catalogId, nextId);
  return Object.freeze({
    bytes,
    count: dests.length,
    outputSha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

/** OCG optional-content groups with /OCProperties on catalog. */
export function writeClassicOcgPdf({
  groups = [{ name: 'Base', on: true }, { name: 'Markup', on: false }],
  width = 612,
  height = 792,
} = {}) {
  const list = groups.slice(0, 32);
  const objects = new Map();
  let nextId = 1;
  const alloc = () => nextId++;
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const ocgIds = [];
  for (const g of list) {
    const ocgId = alloc();
    ocgIds.push({ id: ocgId, name: String(g.name ?? 'Layer').slice(0, 64), on: g.on !== false });
    objects.set(ocgId, `<< /Type /OCG /Name ${pdfLiteral(String(g.name ?? 'Layer').slice(0, 64))} >>`);
  }
  const onRefs = ocgIds.filter((g) => g.on).map((g) => `${g.id} 0 R`).join(' ');
  const orderRefs = ocgIds.map((g) => `${g.id} 0 R`).join(' ');
  const ocPropsId = alloc();
  objects.set(
    ocPropsId,
    `<< /OCGs [${ocgIds.map((g) => `${g.id} 0 R`).join(' ')}] /D << /Order [${orderRefs}] /ON [${onRefs}] /OFF [] /BaseState /ON >> >>`,
  );

  const content = `BT /F1 12 Tf 72 720 Td ${pdfLiteral(`OCG layers n=${list.length}`)} Tj ET\n`;
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /CropBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> /Properties << ${ocgIds.map((g, i) => `/OC${i + 1} ${g.id} 0 R`).join(' ')} >> >> >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /OCProperties ${ocPropsId} 0 R >>`);

  const bytes = finalize(objects, catalogId, nextId);
  return Object.freeze({
    bytes,
    groups: ocgIds.map((g) => ({ name: g.name, on: g.on })),
    count: ocgIds.length,
    outputSha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

/** Content-stream watermark + FreeText-style watermark marker in stream. */
export function writeClassicWatermarkPdf({
  text = 'CONFIDENTIAL',
  width = 612,
  height = 792,
} = {}) {
  const mark = String(text).slice(0, 80);
  const objects = new Map();
  let nextId = 1;
  const alloc = () => nextId++;
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const content = [
    'q 0.75 0.75 0.75 rg',
    'BT /F1 48 Tf 120 400 Td 0.5 Ts',
    `${pdfLiteral(mark)} Tj ET`,
    'Q',
    `BT /F1 10 Tf 72 72 Td ${pdfLiteral(`WATERMARK:${mark}`)} Tj ET\n`,
  ].join('\n');
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const bytes = finalize(objects, catalogId, nextId);
  return Object.freeze({
    bytes,
    text: mark,
    outputSha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

/** Full-page background fill + BACKGROUND marker. */
export function writeClassicBackgroundPdf({
  color = [0.9, 0.9, 0.95],
  width = 612,
  height = 792,
} = {}) {
  const [r, g, b] = color.map((n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.9));
  const objects = new Map();
  let nextId = 1;
  const alloc = () => nextId++;
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const content = [
    `q ${r} ${g} ${b} rg 0 0 ${width} ${height} re f Q`,
    'BT /F1 12 Tf 72 720 Td (BACKGROUND_FILL) Tj ET\n',
  ].join('\n');
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /CropBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const bytes = finalize(objects, catalogId, nextId);
  return Object.freeze({
    bytes,
    color: [r, g, b],
    outputSha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

/** Info dictionary metadata mutation (Title/Author/Subject). */
export function writeClassicMetadataPdf({
  title = 'Metadata title',
  author = 'Local author',
  subject = 'Professional metadata',
  width = 612,
  height = 792,
} = {}) {
  const objects = new Map();
  let nextId = 1;
  const alloc = () => nextId++;
  const catalogId = alloc();
  const pagesId = alloc();
  const pageId = alloc();
  const contentId = alloc();
  const fontId = alloc();
  const infoId = alloc();
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const content = `BT /F1 12 Tf 72 720 Td ${pdfLiteral(`Meta ${title}`)} Tj ET\n`;
  objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
  objects.set(pagesId, `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  objects.set(infoId, `<< /Title ${pdfLiteral(String(title).slice(0, 120))} /Author ${pdfLiteral(String(author).slice(0, 80))} /Subject ${pdfLiteral(String(subject).slice(0, 120))} /Producer (Platen metadata) >>`);
  const bytes = finalize(objects, catalogId, nextId, infoId);
  return Object.freeze({
    bytes,
    title: String(title),
    author: String(author),
    subject: String(subject),
    outputSha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

/** Bates-style footer numbering on each page content stream. */
export function writeClassicBatesPdf({
  prefix = 'CASE',
  start = 1,
  pages = 3,
  width = 612,
  height = 792,
} = {}) {
  const pageCount = Math.max(1, Math.min(100, Number(pages) || 1));
  const objects = new Map();
  let nextId = 1;
  const alloc = () => nextId++;
  const catalogId = alloc();
  const pagesId = alloc();
  const fontId = alloc();
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  for (let i = 0; i < pageCount; i += 1) {
    const n = Number(start) + i;
    const bates = `${String(prefix).slice(0, 20)}-${String(n).padStart(6, '0')}`;
    const contentId = alloc();
    const pageId = alloc();
    pageIds.push(pageId);
    const content = [
      `BT /F1 10 Tf 72 36 Td ${pdfLiteral(`BATES:${bates}`)} Tj ET`,
      `BT /F1 12 Tf 72 720 Td ${pdfLiteral(`Body page ${i + 1}`)} Tj ET\n`,
    ].join('\n');
    objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
    objects.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
  }
  objects.set(pagesId, `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const bytes = finalize(objects, catalogId, nextId);
  return Object.freeze({
    bytes,
    pageCount,
    prefix: String(prefix),
    start: Number(start),
    outputSha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
