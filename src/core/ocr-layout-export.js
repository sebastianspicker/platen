import { PlatenError } from './errors.js';
import { spreadsheetSafeCsvCell } from './spreadsheet-safe-csv.js';

const MAX_RECORDS = 32;
const MAX_WORDS = 100_000;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 32;
const MAX_CELL_TEXT_LENGTH = 4_000;
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 4 * 1024 * 1024;

function invalid(message) {
  throw new PlatenError('OCR_LAYOUT_INVALID', message);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function checkedBounds(bounds) {
  if (!bounds || ['x', 'y', 'width', 'height'].some((key) => !Number.isFinite(bounds[key]) || bounds[key] < 0 || bounds[key] > 1)
    || bounds.x + bounds.width > 1.000001 || bounds.y + bounds.height > 1.000001) {
    invalid('OCR word geometry must remain inside its page.');
  }
  return bounds;
}

export function ocrLayoutHtml(result) {
  const records = result?.records;
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_RECORDS) invalid('OCR layout records are missing or exceed the local limit.');
  const pages = new Map();
  let wordCount = 0;
  for (const record of records) {
    if (!Number.isSafeInteger(record?.page) || record.page < 1 || !Array.isArray(record?.layout?.words)) invalid('OCR layout record is invalid.');
    const width = record.pageSize?.widthPoints; const height = record.pageSize?.heightPoints;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) invalid('OCR page geometry is invalid.');
    const page = pages.get(record.page) ?? { width, height, words: [] };
    if (page.width !== width || page.height !== height) invalid('OCR page geometry is inconsistent.');
    for (const word of record.layout.words) {
      wordCount += 1;
      if (wordCount > MAX_WORDS || typeof word?.text !== 'string' || word.text.length > 4_000) invalid('OCR words exceed the local export limit.');
      page.words.push({ text: word.text, confidence: word.confidence, bounds: checkedBounds(word.bounds) });
    }
    pages.set(record.page, page);
  }
  const pageMarkup = [...pages.entries()].sort(([left], [right]) => left - right).map(([pageNumber, page]) => {
    const words = page.words.map(({ text, confidence, bounds }) => {
      const style = `left:${(bounds.x * 100).toFixed(4)}%;top:${(bounds.y * 100).toFixed(4)}%;width:${(bounds.width * 100).toFixed(4)}%;height:${(bounds.height * 100).toFixed(4)}%`;
      return `<span data-confidence="${escapeHtml(confidence)}" style="${style}">${escapeHtml(text)}</span>`;
    }).join('');
    return `<section><h2>Page ${pageNumber}</h2><div class="ocr-page" style="aspect-ratio:${page.width}/${page.height}" aria-label="OCR layout for page ${pageNumber}">${words}</div></section>`;
  }).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width"><title>Positioned OCR review</title><style>body{font:16px system-ui;margin:2rem;background:#f4f4f1;color:#181816}main{max-width:70rem;margin:auto}.ocr-page{position:relative;background:white;border:1px solid #aaa;overflow:hidden}.ocr-page span{position:absolute;overflow:hidden;white-space:nowrap;font-size:clamp(6px,1vw,14px);line-height:1}</style></head><body><main data-profile="positioned-ocr-review-v1"><h1>Positioned OCR review</h1><p>Coordinates are locally recognized geometry. Original fonts, semantic reading order, and authoritative table structure are not preserved.</p>${pageMarkup}</main></body></html>`;
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) invalid('OCR layout HTML exceeds the local export limit.');
  return html;
}

function quotedCsvCell(cell) {
  if (!cell || typeof cell !== 'object' || typeof cell.text !== 'string'
    || cell.text.length > MAX_CELL_TEXT_LENGTH || cell.text.includes('\0')) {
    invalid('OCR table cells are malformed or exceed the local export limit.');
  }
  return spreadsheetSafeCsvCell(cell.text);
}

export function ocrTableCsv(result, { recordIndex = 0, candidateIndex = 0 } = {}) {
  const records = result?.records;
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_RECORDS
    || !Number.isSafeInteger(recordIndex) || recordIndex < 0 || recordIndex >= records.length
    || !Number.isSafeInteger(candidateIndex) || candidateIndex < 0) {
    invalid('OCR table selection is invalid.');
  }
  const candidates = records[recordIndex]?.tableCandidates;
  if (!Array.isArray(candidates) || candidateIndex >= candidates.length) invalid('The selected OCR table candidate is unavailable.');
  const grid = candidates[candidateIndex]?.grid;
  if (!Array.isArray(grid) || grid.length < 2 || grid.length > MAX_TABLE_ROWS) invalid('OCR table rows are missing or exceed the local export limit.');
  const columnCount = Array.isArray(grid[0]) ? grid[0].length : 0;
  if (columnCount < 2 || columnCount > MAX_TABLE_COLUMNS
    || grid.some((row) => !Array.isArray(row) || row.length !== columnCount)) {
    invalid('OCR table columns are malformed or exceed the local export limit.');
  }
  const encoder = new TextEncoder();
  const rows = [];
  let byteLength = 0;
  for (const row of grid) {
    const encoded = `${row.map(quotedCsvCell).join(',')}\r\n`;
    byteLength += encoder.encode(encoded).byteLength;
    if (byteLength > MAX_CSV_BYTES) invalid('OCR table CSV exceeds the local export limit.');
    rows.push(encoded);
  }
  return rows.join('');
}
