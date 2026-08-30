/**
 * Minimal classic PDF builders for professional structure claims
 * (outlines, passive multi-page sources for GoTo links).
 */
import { createHash } from 'node:crypto';

function utf16BePdfString(text) {
  const units = [];
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      const c = code - 0x10000;
      units.push(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else {
      units.push(code);
    }
  }
  let hex = 'FEFF';
  for (const u of units) hex += u.toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

/**
 * Classic passive N-page PDF with MediaBox + CropBox (goto-link subset).
 */
export function buildClassicPassivePdf({ pages = 1, width = 612, height = 792 } = {}) {
  const pageCount = Math.max(1, Math.min(100, Number(pages) || 1));
  const chunks = ['%PDF-1.7\n'];
  const offsets = new Map();
  const object = (number, body) => {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  };

  // 1 Catalog, 2 Pages, 3.. pages, then content streams
  const pageObjStart = 3;
  const contentObjStart = pageObjStart + pageCount;
  const kids = [];
  for (let i = 0; i < pageCount; i += 1) {
    kids.push(`${pageObjStart + i} 0 R`);
  }
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${pageCount} /Kids [ ${kids.join(' ')} ] >>`);
  for (let i = 0; i < pageCount; i += 1) {
    const contentRef = contentObjStart + i;
    object(
      pageObjStart + i,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /CropBox [0 0 ${width} ${height}] /Contents ${contentRef} 0 R /Resources << >> >>`,
    );
  }
  for (let i = 0; i < pageCount; i += 1) {
    const stream = 'q\nQ\n';
    object(contentObjStart + i, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
  }
  const size = contentObjStart + pageCount;
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let n = 1; n < size; n += 1) {
    chunks.push(`${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

/**
 * Classic multipage PDF with a real /Outlines tree (Title + First/Last/Count + Dest).
 * @param {{ titles?: string[], width?: number, height?: number }} [options]
 */
export function writeClassicOutlinePdf({ titles = ['Cover', 'Chapter One', 'Appendix'], width = 612, height = 792 } = {}) {
  const items = titles.slice(0, 50).map((t) => String(t).slice(0, 120));
  if (items.length < 1) items.push('Document');
  const pageCount = items.length;
  const chunks = ['%PDF-1.7\n'];
  const offsets = new Map();
  const object = (number, body) => {
    offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1'));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  };

  // Layout:
  // 1 Catalog (with Outlines)
  // 2 Pages
  // 3..2+pageCount : Page objects
  // next: content streams
  // then: outline root + outline items
  const pageObjStart = 3;
  const contentObjStart = pageObjStart + pageCount;
  const outlineRootObj = contentObjStart + pageCount;
  const outlineItemStart = outlineRootObj + 1;

  const kids = [];
  for (let i = 0; i < pageCount; i += 1) kids.push(`${pageObjStart + i} 0 R`);

  object(1, `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlineRootObj} 0 R /PageMode /UseOutlines >>`);
  object(2, `<< /Type /Pages /Count ${pageCount} /Kids [ ${kids.join(' ')} ] >>`);

  for (let i = 0; i < pageCount; i += 1) {
    const contentRef = contentObjStart + i;
    object(
      pageObjStart + i,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /CropBox [0 0 ${width} ${height}] /Contents ${contentRef} 0 R /Resources << >> >>`,
    );
  }
  for (let i = 0; i < pageCount; i += 1) {
    const stream = 'q\nQ\n';
    object(contentObjStart + i, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
  }

  const firstItem = outlineItemStart;
  const lastItem = outlineItemStart + pageCount - 1;
  object(outlineRootObj, `<< /Type /Outlines /First ${firstItem} 0 R /Last ${lastItem} 0 R /Count ${pageCount} >>`);

  for (let i = 0; i < pageCount; i += 1) {
    const obj = outlineItemStart + i;
    const pageRef = pageObjStart + i;
    const title = utf16BePdfString(items[i]);
    const prev = i > 0 ? `/Prev ${obj - 1} 0 R ` : '';
    const next = i < pageCount - 1 ? `/Next ${obj + 1} 0 R ` : '';
    // Dest: [page /XYZ left top zoom]
    object(
      obj,
      `<< /Title ${title} /Parent ${outlineRootObj} 0 R ${prev}${next}/Dest [ ${pageRef} 0 R /XYZ 0 ${height} 0 ] >>`,
    );
  }

  const size = outlineItemStart + pageCount;
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let n = 1; n < size; n += 1) {
    chunks.push(`${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const bytes = Buffer.from(chunks.join(''), 'latin1');
  return Object.freeze({
    bytes,
    proof: Object.freeze({
      outlineCount: pageCount,
      hasOutlines: bytes.includes(Buffer.from('/Outlines', 'latin1')),
      outputSha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  });
}

export function latin1Includes(pdf, marker) {
  return Buffer.isBuffer(pdf) && pdf.toString('latin1').includes(marker);
}
