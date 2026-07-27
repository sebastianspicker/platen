import { HostError } from './host-error.mjs';

const MAX_CREATED_PAGES = 500;
const MAX_TEXT_LENGTH = 1_000_000;
const MIN_PAGE_POINTS = 72;
const MAX_PAGE_POINTS = 14_400;

function boundedNumber(value, label) {
  if (!Number.isFinite(value) || value < MIN_PAGE_POINTS || value > MAX_PAGE_POINTS) {
    throw new HostError('INVALID_PAGE_SIZE', `${label} must be from ${MIN_PAGE_POINTS} through ${MAX_PAGE_POINTS} points.`, 400);
  }
  return Number(value.toFixed(3));
}

function pageCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CREATED_PAGES) {
    throw new HostError('INVALID_PAGE_COUNT', `Created PDFs may contain from 1 through ${MAX_CREATED_PAGES} pages.`, 400);
  }
  return value;
}

function pdfString(value) {
  return String(value)
    .normalize('NFKC')
    .replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, '?')
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
}

function contentStream(text, width, height) {
  const normalized = String(text ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw new HostError('TEXT_TOO_LARGE', `Created PDF text is limited to ${MAX_TEXT_LENGTH} characters.`, 413);
  }
  if (!normalized) return '';
  const lines = normalized.split('\n').slice(0, 2_000);
  const left = Math.max(24, Math.min(72, width / 10));
  const top = Math.max(24, Math.min(72, height / 10));
  const commands = ['BT', '/F1 11 Tf', '14 TL', `${left} ${height - top} Td`];
  for (const [index, line] of lines.entries()) {
    if (index) commands.push('T*');
    commands.push(`(${pdfString(line.slice(0, 2_000))}) Tj`);
  }
  commands.push('ET');
  return `${commands.join('\n')}\n`;
}

function assemblePdf(pageTexts, { widthPoints, heightPoints, title }) {
  const width = boundedNumber(widthPoints, 'widthPoints');
  const height = boundedNumber(heightPoints, 'heightPoints');
  const count = pageCount(pageTexts.length);
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const pageReferences = [];
  for (const text of pageTexts) {
    const stream = contentStream(text, width, height);
    const pageReference = objects.length + 1;
    const contentReference = pageReference + 1;
    pageReferences.push(`${pageReference} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentReference} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, 'binary')} >>\nstream\n${stream}endstream`,
    );
  }
  const infoReference = objects.length + 1;
  objects.push(`<< /Title (${pdfString(title || 'Untitled')}) /Producer (Platen local factory) >>`);
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageReferences.join(' ')}] /Count ${count} >>`;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoReference} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

export function createBlankPdf({
  pages = 1, widthPoints = 612, heightPoints = 792, title = 'Untitled',
} = {}) {
  return assemblePdf(Array.from({ length: pageCount(pages) }, () => ''), {
    widthPoints, heightPoints, title,
  });
}

export function createTextPdf({
  text, pages = null, widthPoints = 612, heightPoints = 792, title = 'Local text document',
} = {}) {
  const pageTexts = pages ?? [String(text ?? '')];
  if (!Array.isArray(pageTexts) || pageTexts.some((value) => typeof value !== 'string')) {
    throw new HostError('INVALID_TEXT_PAGES', 'Text PDF pages must be an array of strings.', 400);
  }
  return assemblePdf(pageTexts, { widthPoints, heightPoints, title });
}

export { MAX_CREATED_PAGES, MAX_TEXT_LENGTH, pdfString };
