/**
 * Pure multi-page PDF assembler for professional page-organization claims.
 * Emits real /Count, /Kids, /MediaBox, optional /CropBox and /Rotate, and
 * per-page content markers inspectable via latin1.
 */
import { createHash } from 'node:crypto';

function pdfLiteral(text) {
  return `(${String(text).replace(/[\\()]/g, (ch) => `\\${ch}`)})`;
}

/**
 * @param {{
 *   pages?: Array<{
 *     text?: string,
 *     marker?: string,
 *     width?: number,
 *     height?: number,
 *     rotate?: number,
 *     crop?: { left: number, bottom: number, right: number, top: number },
 *   }>,
 *   title?: string,
 * }} [options]
 */
export function assemblePageOpsPdf({ pages, title = 'Page ops' } = {}) {
  const list = Array.isArray(pages) && pages.length
    ? pages.slice(0, 500)
    : [{ text: 'Page 1', marker: 'PAGE_OPS:1' }];
  const objects = new Map();
  let nextId = 1;
  const alloc = () => nextId++;
  const catalogId = alloc();
  const pagesId = alloc();
  const fontId = alloc();
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const kidRefs = [];
  for (let i = 0; i < list.length; i += 1) {
    const spec = list[i] ?? {};
    const width = Number.isFinite(spec.width) ? Number(spec.width) : 612;
    const height = Number.isFinite(spec.height) ? Number(spec.height) : 792;
    const rotate = [0, 90, 180, 270].includes(spec.rotate) ? spec.rotate : 0;
    const crop = spec.crop && typeof spec.crop === 'object'
      ? spec.crop
      : { left: 0, bottom: 0, right: width, top: height };
    const marker = String(spec.marker ?? `PAGE_OPS:${i + 1}`).slice(0, 80);
    const text = String(spec.text ?? marker).slice(0, 500);
    const content = [
      'BT /F1 12 Tf 72 720 Td',
      `${pdfLiteral(marker)} Tj`,
      '0 -16 Td',
      `${pdfLiteral(text.slice(0, 200))} Tj ET\n`,
    ].join('\n');
    const contentId = alloc();
    const pageId = alloc();
    kidRefs.push(pageId);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
    const rotatePart = rotate !== 0 ? ` /Rotate ${rotate}` : '';
    const cropPart = ` /CropBox [${crop.left} ${crop.bottom} ${crop.right} ${crop.top}]`;
    objects.set(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}]${cropPart}${rotatePart} /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
  }

  objects.set(pagesId, `<< /Type /Pages /Count ${list.length} /Kids [${kidRefs.map((id) => `${id} 0 R`).join(' ')}] >>`);
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  // Info with title for metadata claims
  const infoId = alloc();
  objects.set(infoId, `<< /Title ${pdfLiteral(String(title).slice(0, 120))} /Producer (Platen page-ops) >>`);

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
  const idBytes = createHash('sha256')
    .update(Buffer.concat(parts.map((p) => Buffer.from(p, 'latin1'))))
    .digest()
    .subarray(0, 16);
  const hex = idBytes.toString('hex');
  parts.push(
    `trailer\n<< /Size ${size} /Root ${catalogId} 0 R /Info ${infoId} 0 R /ID [<${hex}> <${hex}>] >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  const bytes = Buffer.from(parts.join(''), 'latin1');
  const latin1 = bytes.toString('latin1');
  const countMatch = latin1.match(/\/Count\s+(\d+)/);
  return Object.freeze({
    bytes,
    pageCount: list.length,
    structuralCount: countMatch ? Number(countMatch[1]) : -1,
    title: String(title),
    outputSha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

/** Count /Type /Page occurrences (approximate page objects). */
export function countPageObjects(pdf) {
  const s = Buffer.isBuffer(pdf) ? pdf.toString('latin1') : String(pdf);
  return (s.match(/\/Type\s*\/Page(?![sA-Za-z])/g) ?? []).length;
}

export function assertPageTree(pdf, expectedCount, requiredMarkers = []) {
  const s = Buffer.isBuffer(pdf) ? pdf.toString('latin1') : String(pdf);
  if (!s.includes('/Type /Pages') && !s.includes('/Type/Pages')) {
    throw Object.assign(new Error('Missing /Type /Pages'), { code: 'PAGE_TREE_MISSING' });
  }
  const countMatch = s.match(/\/Count\s+(\d+)/);
  const structural = countMatch ? Number(countMatch[1]) : -1;
  if (structural !== expectedCount) {
    throw Object.assign(
      new Error(`Page /Count ${structural} !== expected ${expectedCount}`),
      { code: 'PAGE_COUNT_MISMATCH' },
    );
  }
  for (const marker of requiredMarkers) {
    if (!s.includes(String(marker))) {
      throw Object.assign(new Error(`Missing marker ${marker}`), { code: 'PAGE_MARKER_MISSING' });
    }
  }
  return structural;
}
