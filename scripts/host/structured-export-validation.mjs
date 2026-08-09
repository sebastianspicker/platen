import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { structuredTextExport } from '../../src/core/document-analysis.js';

export const MAX_STRUCTURED_EXPORT_PAGES = 200;
export const MAX_STRUCTURED_EXPORT_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_STRUCTURED_EXPORT_OUTPUT_BYTES = 16 * 1024 * 1024;

export const STRUCTURED_EXPORT_FORMATS = Object.freeze({
  rtf: Object.freeze({ extension: '.rtf', mediaType: 'application/rtf' }),
  html: Object.freeze({ extension: '.html', mediaType: 'text/html;charset=utf-8' }),
  xml: Object.freeze({ extension: '.xml', mediaType: 'application/xml;charset=utf-8' }),
});

export const STRUCTURED_EXPORT_LIMITATIONS = Object.freeze([
  'Text-only export from Poppler-extracted page records.',
  'Exact visual, pagination, font, table, reading-order, layout, and editable-object fidelity is not certified.',
]);

const SHA256 = /^[a-f0-9]{64}$/u;

function invalid(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 422;
  throw error;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function formatDefinition(format) {
  const definition = STRUCTURED_EXPORT_FORMATS[format];
  if (!definition) invalid('CLI_INVALID_STRUCTURED_EXPORT', 'Structured export format must be rtf, html, or xml.');
  return definition;
}

function assertSequentialPages(pages, pageCount) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_STRUCTURED_EXPORT_PAGES) {
    invalid('CLI_INVALID_STRUCTURED_EXPORT', `Structured export supports 1–${MAX_STRUCTURED_EXPORT_PAGES} pages.`);
  }
  if (!Array.isArray(pages) || pages.length !== pageCount) {
    invalid('CLI_INVALID_STRUCTURED_EXPORT', 'Text extraction did not return the inspected page count.');
  }
  let aggregateBytes = 0;
  const normalized = pages.map((page, index) => {
    if (!page || page.page !== index + 1 || typeof page.text !== 'string') {
      invalid('CLI_INVALID_STRUCTURED_EXPORT', 'Text extraction returned non-sequential page records.');
    }
    aggregateBytes += Buffer.byteLength(page.text, 'utf8') + (index ? 1 : 0);
    if (aggregateBytes > MAX_STRUCTURED_EXPORT_TEXT_BYTES) {
      invalid('CLI_STRUCTURED_EXPORT_TOO_LARGE', 'Structured export text exceeds the 8 MiB aggregate limit.');
    }
    return Object.freeze({ page: page.page, text: page.text });
  });
  const aggregateText = normalized.map(({ text }) => text).join('\n');
  return Object.freeze({
    pages: Object.freeze(normalized),
    pageCount,
    aggregateBytes,
    aggregateTextSha256: digest(Buffer.from(aggregateText, 'utf8')),
  });
}

function assertUtf8(bytes, format) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_STRUCTURED_EXPORT_OUTPUT_BYTES) {
    invalid('CLI_INVALID_STRUCTURED_EXPORT_OUTPUT', `${format.toUpperCase()} export output is outside the bounded byte limit.`);
  }
  if (bytes.includes(0)) invalid('CLI_INVALID_STRUCTURED_EXPORT_OUTPUT', 'Structured export output contains a NUL byte.');
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw new Error('round trip mismatch');
    return decoded;
  } catch {
    invalid('CLI_INVALID_STRUCTURED_EXPORT_OUTPUT', 'Structured export output is not valid UTF-8.');
  }
}

function assertSequentialMarkers(text, pattern, pageCount, label) {
  const pages = [];
  let match;
  while ((match = pattern.exec(text)) !== null) pages.push(Number(match[1]));
  if (pages.length !== pageCount || pages.some((page, index) => page !== index + 1)) {
    invalid('CLI_INVALID_STRUCTURED_EXPORT_OUTPUT', `${label} does not contain exactly the sequential page records.`);
  }
}

function validateFormat(text, format, pageCount) {
  if (format === 'rtf') {
    if (!text.startsWith('{\\rtf1\\ansi\\deff0\n')) invalid('CLI_INVALID_STRUCTURED_EXPORT_OUTPUT', 'RTF output has an invalid header.');
    assertSequentialMarkers(text, /\\b Page (\d+)\\b0\\line\n/gu, pageCount, 'RTF output');
    return;
  }
  if (format === 'html') {
    if (!text.startsWith('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>')
      || !text.includes('</head><body>\n') || !text.endsWith('\n</body></html>\n')) {
      invalid('CLI_INVALID_STRUCTURED_EXPORT_OUTPUT', 'HTML output has an invalid document root.');
    }
    assertSequentialMarkers(text, /<section data-page="(\d+)"><h2>Page \1<\/h2><pre>/gu, pageCount, 'HTML output');
    return;
  }
  if (!text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<document ')
    || !text.endsWith('\n</document>\n')) {
    invalid('CLI_INVALID_STRUCTURED_EXPORT_OUTPUT', 'XML output has an invalid document root.');
  }
  assertSequentialMarkers(text, /<page number="(\d+)">[\s\S]*?<\/page>/gu, pageCount, 'XML output');
}

export function validateStructuredExportRequest({ format, output } = {}) {
  const definition = formatDefinition(format);
  if (typeof output !== 'string' || extname(output).toLowerCase() !== definition.extension) {
    invalid('CLI_INVALID_STRUCTURED_EXPORT', `Structured ${format.toUpperCase()} export requires a ${definition.extension} output.`);
  }
  return Object.freeze({ format, ...definition });
}

export function buildValidatedStructuredExport({ pages, pageCount, format, title } = {}) {
  const definition = formatDefinition(format);
  const checked = assertSequentialPages(pages, pageCount);
  let exported;
  try {
    exported = structuredTextExport(checked.pages, format, { title: String(title ?? 'PDF export') });
  } catch (error) {
    if (format === 'xml' && error instanceof TypeError) {
      error.code ??= 'CLI_INVALID_STRUCTURED_EXPORT_INPUT';
    }
    throw error;
  }
  if (exported.extension !== definition.extension.slice(1) || exported.mediaType !== definition.mediaType) {
    invalid('CLI_INVALID_STRUCTURED_EXPORT_OUTPUT', 'Structured export returned mismatched format metadata.');
  }
  const bytes = Buffer.from(exported.data, 'utf8');
  const text = assertUtf8(bytes, format);
  validateFormat(text, format, checked.pageCount);
  return Object.freeze({
    bytes,
    format,
    extension: definition.extension,
    mediaType: definition.mediaType,
    pageCount: checked.pageCount,
    aggregateTextBytes: checked.aggregateBytes,
    aggregateTextSha256: checked.aggregateTextSha256,
    outputSha256: digest(bytes),
  });
}

export function assertStructuredExportSourceSha256(value) {
  if (!SHA256.test(String(value ?? ''))) invalid('CLI_INVALID_STRUCTURED_EXPORT', 'The uploaded source has no valid SHA-256 digest.');
  return value;
}
