import { HostError } from './host-error.mjs';

export const DEFAULT_OCR_LAYOUT_LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxRows: 100_000, maxTextLength: 4_000, maxPagePixels: 100_000_000, maxHtmlBytes: 4 * 1024 * 1024, maxTableRows: 200, maxTableColumns: 32 });
function fail(code, message, status = 400) { throw new HostError(code, message, status); }
function integer(value, label, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('OCR_LAYOUT_INVALID', `${label} is invalid.`, 422); return value; }
function escape(value) { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function geometry(left, top, width, height, imageWidth, imageHeight, zone) { return Object.freeze({ x: zone.x + (left / imageWidth) * zone.width, y: zone.y + (top / imageHeight) * zone.height, width: (width / imageWidth) * zone.width, height: (height / imageHeight) * zone.height }); }
function validZone(source) {
  if (!source || typeof source !== 'object') return false;
  const coordinates = ['x', 'y', 'width', 'height'];
  if (coordinates.some((key) => !Number.isFinite(source[key]) || source[key] < 0 || source[key] > 1)) {
    return false;
  }
  return source.x + source.width <= 1
    && source.y + source.height <= 1
    && source.width > 0
    && source.height > 0;
}

function normalizeOptions(options) {
  const limits = { ...DEFAULT_OCR_LAYOUT_LIMITS, ...(options.limits ?? {}) };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail('OCR_LAYOUT_INVALID', 'Layout limits are invalid.');
    }
  }

  const imageWidth = integer(options.imageWidth, 'imageWidth', 1, limits.maxPagePixels);
  const imageHeight = integer(options.imageHeight, 'imageHeight', 1, limits.maxPagePixels);
  if (imageWidth * imageHeight > limits.maxPagePixels) {
    fail('OCR_LAYOUT_INVALID', 'OCR image exceeds layout pixel bounds.', 422);
  }

  const source = options.zone ?? { x: 0, y: 0, width: 1, height: 1 };
  if (!validZone(source)) fail('OCR_LAYOUT_INVALID', 'OCR zone is invalid.', 422);
  return { limits, imageWidth, imageHeight, zone: source };
}

export function parseTesseractTsvHierarchy(tsv, options = {}) {
  if (typeof tsv !== 'string' || Buffer.byteLength(tsv) > (options.limits?.maxBytes ?? DEFAULT_OCR_LAYOUT_LIMITS.maxBytes)) fail('OCR_TSV_INVALID', 'OCR TSV is missing or exceeds the local limit.', 422);
  const { limits, imageWidth, imageHeight, zone } = normalizeOptions(options); const lines = tsv.split(/\r?\n/u); if (!lines.length || lines[0] !== 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext') fail('OCR_TSV_INVALID', 'OCR TSV header is invalid.', 422); if (lines.length - 1 > limits.maxRows) fail('OCR_TSV_LIMIT', 'OCR TSV exceeds the row limit.', 422);
  const nodes = []; const words = []; const parents = new Set(); const ids = new Set();
  for (const [index, line] of lines.slice(1).entries()) {
    if (!line) continue;
    const cells = line.split('\t');
    if (cells.length !== 12) fail('OCR_TSV_INVALID', `OCR TSV row ${index + 2} is malformed.`, 422);
    const [level, page, block, paragraph, lineNo, word, left, top, width, height] = cells.slice(0, 10).map(Number);
    const confidence = Number(cells[10]); const text = cells[11];
    const integerFields = [level, page, block, paragraph, lineNo, word, left, top, width, height];
    if (![1, 2, 3, 4, 5].includes(level) || !integerFields.every(Number.isSafeInteger)
      || page < 1 || block < 0 || paragraph < 0 || lineNo < 0 || word < 0
      || left < 0 || top < 0 || width < 0 || height < 0 || left + width > imageWidth || top + height > imageHeight
      || !Number.isFinite(confidence) || confidence < -1 || confidence > 100 || text.length > limits.maxTextLength
      || (level === 5 && text && (width === 0 || height === 0 || confidence < 0))) {
      fail('OCR_TSV_INVALID', `OCR TSV row ${index + 2} is invalid.`, 422);
    }
    const id = `${page}:${block}:${paragraph}:${lineNo}:${word}`;
    if (ids.has(id)) fail('OCR_TSV_INVALID', `OCR TSV row ${index + 2} duplicates a hierarchy identifier.`, 422);
    if (level > 1) {
      const parent = level === 2 ? `${page}:0:0:0:0` : level === 3 ? `${page}:${block}:0:0:0` : level === 4 ? `${page}:${block}:${paragraph}:0:0` : `${page}:${block}:${paragraph}:${lineNo}:0`;
      if (!parents.has(parent)) fail('OCR_TSV_INVALID', `OCR TSV row ${index + 2} has no hierarchy parent.`, 422);
    }
    const node = Object.freeze({ id, level, page, block, paragraph, line: lineNo, word, confidence, text, bounds: geometry(left, top, width, height, imageWidth, imageHeight, zone) });
    nodes.push(node); parents.add(id); ids.add(id); if (level === 5 && text) words.push(node);
  }
  const tableCandidates = tableCandidatesFromWords(words, { maxRows: limits.maxTableRows, maxColumns: limits.maxTableColumns, maxTextLength: limits.maxTextLength }); return Object.freeze({ schemaVersion: 1, image: Object.freeze({ width: imageWidth, height: imageHeight, zone: Object.freeze({ ...zone }) }), nodes: Object.freeze(nodes), words: Object.freeze(words), tableCandidates });
}
function tableCell(words, maxTextLength) {
  const ordered = [...words].sort((left, right) => left.bounds.x - right.bounds.x);
  if (!ordered.length) return Object.freeze({ text: '', wordIds: Object.freeze([]), bounds: null, truncated: false });
  const left = Math.min(...ordered.map((word) => word.bounds.x)); const top = Math.min(...ordered.map((word) => word.bounds.y));
  const right = Math.max(...ordered.map((word) => word.bounds.x + word.bounds.width)); const bottom = Math.max(...ordered.map((word) => word.bounds.y + word.bounds.height));
  let text = ''; let truncated = false;
  for (const word of ordered) {
    const next = text ? ` ${word.text}` : word.text;
    if (text.length + next.length > maxTextLength) {
      text += next.slice(0, maxTextLength - text.length); truncated = true; break;
    }
    text += next;
  }
  return Object.freeze({
    text,
    wordIds: Object.freeze(ordered.map(({ id }) => id)),
    bounds: Object.freeze({ x: left, y: top, width: right - left, height: bottom - top }),
    truncated,
  });
}
export function tableCandidatesFromWords(words, { maxRows = 200, maxColumns = 32, maxTextLength = 4_000 } = {}) {
  if (![maxRows, maxColumns, maxTextLength].every((value) => Number.isSafeInteger(value) && value > 0)) fail('OCR_LAYOUT_INVALID', 'Table extraction limits are invalid.');
  const byLine = new Map();
  for (const word of words) { const key = `${word.page}:${word.block}:${word.paragraph}:${word.line}`; const row = byLine.get(key) ?? []; row.push(word); byLine.set(key, row); }
  const allRows = [...byLine.values()].filter((row) => row.length >= 2).map((row) => row.sort((left, right) => left.bounds.x - right.bounds.x)).sort((a, b) => a[0].bounds.y - b[0].bounds.y);
  const rows = allRows.slice(0, maxRows);
  if (rows.length < 2) return Object.freeze([]);
  const columns = Math.min(maxColumns, ...rows.map((row) => row.length));
  if (columns < 2) return Object.freeze([]);
  const anchors = Array.from({ length: columns }, (_, column) => rows.reduce((total, row) => total + row[column].bounds.x, 0) / rows.length);
  let aligned = 0;
  for (const row of rows) for (let column = 0; column < columns; column += 1) if (Math.abs(row[column].bounds.x - anchors[column]) <= 0.04) aligned += 1;
  const alignmentScore = aligned / (rows.length * columns);
  if (alignmentScore < 0.6) return Object.freeze([]);
  const grid = rows.map((row) => {
    const buckets = Array.from({ length: columns }, () => []);
    for (const word of row) {
      let target = 0;
      for (let column = 1; column < columns; column += 1) if (Math.abs(word.bounds.x - anchors[column]) < Math.abs(word.bounds.x - anchors[target])) target = column;
      buckets[target].push(word);
    }
    return Object.freeze(buckets.map((bucket) => tableCell(bucket, maxTextLength)));
  });
  const members = rows.flat(); const left = Math.min(...members.map((word) => word.bounds.x)); const top = Math.min(...members.map((word) => word.bounds.y)); const right = Math.max(...members.map((word) => word.bounds.x + word.bounds.width)); const bottom = Math.max(...members.map((word) => word.bounds.y + word.bounds.height));
  const truncated = allRows.length > rows.length || grid.some((row) => row.some((cell) => cell.truncated));
  return Object.freeze([Object.freeze({ method: 'tesseract-tsv-geometry-heuristic', reviewRequired: true, alignmentScore: Math.round(alignmentScore * 1000) / 1000, rows: rows.length, columns, truncated, bounds: Object.freeze({ x: left, y: top, width: right - left, height: bottom - top }), wordIds: Object.freeze(members.map((word) => word.id)), grid: Object.freeze(grid) })]);
}
export function exportOcrLayoutJson(model, maxBytes = DEFAULT_OCR_LAYOUT_LIMITS.maxBytes) { const output = JSON.stringify(model); if (Buffer.byteLength(output) > maxBytes) fail('OCR_LAYOUT_LIMIT', 'OCR layout export exceeds the local limit.', 413); return output; }
export function exportOcrLayoutHtml(model, maxBytes = DEFAULT_OCR_LAYOUT_LIMITS.maxHtmlBytes) {
  const words = Array.isArray(model?.words) ? model.words : [];
  const positioned = words.map((word) => {
    const bounds = word?.bounds;
    if (!bounds || ['x', 'y', 'width', 'height'].some((key) => !Number.isFinite(bounds[key]) || bounds[key] < 0 || bounds[key] > 1)
      || bounds.x + bounds.width > 1.000001 || bounds.y + bounds.height > 1.000001) fail('OCR_LAYOUT_INVALID', 'OCR HTML model contains invalid geometry.', 422);
    const style = `left:${(bounds.x * 100).toFixed(4)}%;top:${(bounds.y * 100).toFixed(4)}%;width:${(bounds.width * 100).toFixed(4)}%;height:${(bounds.height * 100).toFixed(4)}%`;
    return `<span data-ocr-id="${escape(word.id)}" data-confidence="${escape(word.confidence)}" style="${style}">${escape(word.text)}</span>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Local OCR layout review</title><style>main{font:16px system-ui;max-width:80rem;margin:auto}.ocr-page{position:relative;aspect-ratio:1/1;border:1px solid #999}.ocr-page span{position:absolute;overflow:hidden;white-space:nowrap}</style><main><h1>Local OCR layout review</h1><p>Table candidates are geometry heuristics and require review.</p><section class="ocr-page" aria-label="Recognized text layout">${positioned}</section></main>`;
  if (Buffer.byteLength(html) > maxBytes) fail('OCR_LAYOUT_LIMIT', 'OCR HTML export exceeds the local limit.', 413); return html;
}
