import { HostError } from './host-error.mjs';
import {
  MAX_PAGE_BOX_COORDINATE,
  MAX_PAGE_COUNT,
  MAX_RENDER_PAGE_POINTS,
  MAX_STRUCTURE_PAGE_RANGE,
  MAX_TEXT_PAGE_COUNT,
} from './pdf-service-limits.mjs';

const pageBoxNames = Object.freeze({
  mediabox: 'mediaBox', cropbox: 'cropBox', bleedbox: 'bleedBox',
  trimbox: 'trimBox', artbox: 'artBox',
});
const PDF_NUMBER = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';

function invalidOutput(message) {
  return new HostError('INVALID_ENGINE_OUTPUT', message, 502);
}

function parsePdfInfoValues(output) {
  const values = {};
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = normalizeKey(line.slice(0, separator));
    const value = line.slice(separator + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

function assertPageDimension(widthPoints, heightPoints, message) {
  if (!Number.isFinite(widthPoints) || !Number.isFinite(heightPoints)
    || widthPoints <= 0 || heightPoints <= 0) {
    throw invalidOutput(message);
  }
}

function assertBoxRange(firstPage, lastPage) {
  if (!Number.isSafeInteger(firstPage) || !Number.isSafeInteger(lastPage)
    || firstPage < 1 || lastPage < firstPage
    || lastPage - firstPage + 1 > MAX_STRUCTURE_PAGE_RANGE) {
    throw invalidOutput('The requested page-box evidence range is invalid.');
  }
}

function pageBoxPatterns() {
  return {
    size: new RegExp(`^(?:Page\\s+(\\d+)\\s+)?size:\\s*(${PDF_NUMBER})\\s+x\\s+(${PDF_NUMBER})\\s+pts`, 'i'),
    rotation: /^(?:Page\s+(\d+)\s+)?rot:\s*(-?\d+)/i,
    box: new RegExp(`^(?:Page\\s+(\\d+)\\s+)?(MediaBox|CropBox|BleedBox|TrimBox|ArtBox):\\s*(${PDF_NUMBER})\\s+(${PDF_NUMBER})\\s+(${PDF_NUMBER})\\s+(${PDF_NUMBER})\\s*$`, 'i'),
  };
}

function createPageBoxRecord(records, page, firstPage, lastPage) {
  if (page < firstPage || page > lastPage) {
    throw invalidOutput('Poppler reported a page outside the requested box range.');
  }
  if (!records.has(page)) {
    records.set(page, {
      page, widthPoints: null, heightPoints: null, rotation: null, boxes: {},
    });
  }
  return records.get(page);
}

function parsePageSize(match, recordFor, firstPage) {
  const page = Number.parseInt(match[1] ?? String(firstPage), 10);
  const widthPoints = Number.parseFloat(match[2]);
  const heightPoints = Number.parseFloat(match[3]);
  if (!Number.isFinite(widthPoints) || !Number.isFinite(heightPoints)
    || widthPoints <= 0 || heightPoints <= 0
    || widthPoints > MAX_RENDER_PAGE_POINTS || heightPoints > MAX_RENDER_PAGE_POINTS) {
    throw invalidOutput('Poppler reported invalid page dimensions in the box inventory.');
  }
  Object.assign(recordFor(page), { widthPoints, heightPoints });
}

function parsePageRotation(match, recordFor, firstPage) {
  const page = Number.parseInt(match[1] ?? String(firstPage), 10);
  const rotation = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(rotation) || rotation % 90 !== 0 || Math.abs(rotation) > 360) {
    throw invalidOutput('Poppler reported an invalid page rotation.');
  }
  recordFor(page).rotation = ((rotation % 360) + 360) % 360;
}

function parsePageBox(match, recordFor, firstPage) {
  const page = Number.parseInt(match[1] ?? String(firstPage), 10);
  const coordinates = match.slice(3).map(Number);
  if (coordinates.some((value) => !Number.isFinite(value)
    || Math.abs(value) > MAX_PAGE_BOX_COORDINATE)
    || coordinates[2] <= coordinates[0] || coordinates[3] <= coordinates[1]) {
    throw invalidOutput('Poppler reported an invalid page box.');
  }
  recordFor(page).boxes[pageBoxNames[match[2].toLowerCase()]] = Object.freeze({
    left: coordinates[0], bottom: coordinates[1], right: coordinates[2], top: coordinates[3],
    width: coordinates[2] - coordinates[0], height: coordinates[3] - coordinates[1],
  });
}

function freezePageBoxRecords(records, firstPage, lastPage) {
  const pages = [];
  for (let page = firstPage; page <= lastPage; page += 1) {
    const record = records.get(page);
    if (!record || record.widthPoints === null || record.heightPoints === null
      || !record.boxes.mediaBox || !record.boxes.cropBox) {
      throw invalidOutput(`Poppler did not report complete page-box evidence for page ${page}.`);
    }
    pages.push(Object.freeze({ ...record, boxes: Object.freeze({ ...record.boxes }) }));
  }
  return Object.freeze(pages);
}

export function normalizeKey(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, next) => next.toUpperCase());
}

export function parsePdfInfo(output) {
  const values = parsePdfInfoValues(output);
  const pageCount = Number.parseInt(values.pages ?? '', 10);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGE_COUNT) {
    throw invalidOutput('Poppler did not report a valid page count.');
  }
  return Object.freeze({
    pageCount, title: values.title || null, author: values.author || null,
    subject: values.subject || null, keywords: values.keywords || null,
    creator: values.creator || null, producer: values.producer || null,
    createdAt: values.creationDate || null, modifiedAt: values.modDate || null,
    tagged: values.tagged || 'unknown', userProperties: values.userProperties || 'unknown',
    suspects: values.suspects || 'unknown', form: values.form || 'unknown',
    javascript: values.javascript || 'unknown', pages: values.pages,
    encrypted: values.encrypted || 'unknown', pageSize: values.pageSize || null,
    pageRotation: values.pageRot || null, fileSize: values.fileSize || null,
    optimized: values.optimized || 'unknown', pdfVersion: values.pdfVersion || null,
    raw: Object.freeze(values),
  });
}

export function parsePageDimensions(output, page) {
  const text = String(output ?? '');
  const pagePattern = new RegExp(`Page\\s+${page}\\s+size:\\s*([0-9.]+)\\s+x\\s+([0-9.]+)\\s+pts`, 'i');
  const match = text.match(pagePattern) ?? text.match(/Page size:\s*([0-9.]+)\s+x\s+([0-9.]+)\s+pts/i);
  const widthPoints = Number.parseFloat(match?.[1] ?? '');
  const heightPoints = Number.parseFloat(match?.[2] ?? '');
  assertPageDimension(widthPoints, heightPoints, `Poppler did not report valid geometry for page ${page}.`);
  if (widthPoints > MAX_RENDER_PAGE_POINTS || heightPoints > MAX_RENDER_PAGE_POINTS) {
    throw new HostError('PAGE_GEOMETRY_LIMIT', `Page ${page} exceeds the ${MAX_RENDER_PAGE_POINTS}-point render limit.`, 422);
  }
  return Object.freeze({ page, widthPoints, heightPoints });
}

export function parsePageBoxes(output, { firstPage = 1, lastPage = firstPage } = {}) {
  assertBoxRange(firstPage, lastPage);
  const records = new Map();
  const recordFor = (page) => createPageBoxRecord(records, page, firstPage, lastPage);
  const patterns = pageBoxPatterns();
  for (const rawLine of String(output ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    let match = line.match(patterns.size);
    if (match) {
      parsePageSize(match, recordFor, firstPage);
      continue;
    }
    match = line.match(patterns.rotation);
    if (match) {
      parsePageRotation(match, recordFor, firstPage);
      continue;
    }
    match = line.match(patterns.box);
    if (match) parsePageBox(match, recordFor, firstPage);
  }
  return freezePageBoxRecords(records, firstPage, lastPage);
}

export function parseXmpMetadata(output) {
  const xml = String(output ?? '').trim();
  if (xml.includes('\0')) throw invalidOutput('Poppler metadata output contains a NUL byte.');
  return Object.freeze({ present: xml.length > 0, xml: xml || null });
}

export function parseCustomMetadata(output) {
  const records = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name) records.push(Object.freeze({ name, value }));
  }
  return Object.freeze(records);
}

export function parseTaggedStructure(output, { includesText = false } = {}) {
  const lines = String(output ?? '').split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const prefix = line.match(/^[\t ]*/)?.[0] ?? '';
      const depth = [...prefix].reduce((total, character) => total + (character === '\t' ? 2 : 1), 0);
      return Object.freeze({ depth, value: line.trim() });
    });
  return Object.freeze({ present: lines.length > 0, includesText, lines: Object.freeze(lines) });
}

export function parseTextPages(output, expectedPages = null) {
  if (Number.isInteger(expectedPages) && expectedPages > MAX_TEXT_PAGE_COUNT) {
    throw new HostError('DOCUMENT_TOO_LARGE', `Text extraction is limited to ${MAX_TEXT_PAGE_COUNT} pages per document.`, 422);
  }
  const parts = String(output ?? '').replaceAll('\r\n', '\n').split('\f');
  if (parts.at(-1) === '') parts.pop();
  if (Number.isInteger(expectedPages)) {
    while (parts.length < expectedPages) parts.push('');
    if (parts.length > expectedPages) parts.length = expectedPages;
  }
  return Object.freeze(parts.map((text, index) => Object.freeze({ page: index + 1, text: text.trimEnd() })));
}
