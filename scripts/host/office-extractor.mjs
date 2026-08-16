import { readFile } from 'node:fs/promises';
import { HostError } from './host-error.mjs';
import { readZipEntries } from './zip-reader.mjs';

function decodeXml(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]);
}

function xmlText(xml) {
  return decodeXml(xml
    .replace(/<(?:text:|w:)?(?:p|h|tr|br|cr)\b[^>]*>/gi, '\n')
    .replace(/<(?:text:)?(?:tab|s)\b[^>]*\/?>(?:<\/[^>]+>)?/gi, '\t')
    .replace(/<[^>]*>/g, ''))
    .replace(/\r/g, '').replace(/\n[\t ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function taggedText(xml, tag) {
  const matches = tag === 'w:t'
    ? xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)
    : tag === 'a:t'
      ? xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)
      : tag === 't'
        ? xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)
        : tag === 'v'
          ? xml.matchAll(/<v\b[^>]*>([\s\S]*?)<\/v>/gi)
          : [];
  return [...matches].map((match) => xmlText(match[1])).join('');
}

function extractDocx(entries) {
  const document = entries.get('word/document.xml');
  if (!document) throw new HostError('INVALID_OFFICE_ARCHIVE', 'The DOCX archive has no document text.', 422);
  return [...document.toString('utf8').matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi)].map((match) => taggedText(match[1], 'w:t')).filter(Boolean).join('\n');
}

function extractPptx(entries) {
  return [...entries].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(([a], [b]) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    .map(([, value]) => {
      const source = value.toString('utf8');
      const paragraphs = [...source.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi)].map((match) => taggedText(match[1], 'a:t'));
      return (paragraphs.length ? paragraphs : [taggedText(source, 'a:t')]).join('\n');
    }).filter(Boolean).join('\n');
}

function extractXlsx(entries) {
  const shared = entries.get('xl/sharedStrings.xml');
  const strings = shared ? [...shared.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => taggedText(match[1], 't')) : [];
  const sheets = [...entries].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort(([a], [b]) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  if (!sheets.length) throw new HostError('INVALID_OFFICE_ARCHIVE', 'The XLSX archive has no worksheets.', 422);
  return sheets.map(([, source]) => [...source.toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)].map((row) => [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)].map((cell) => {
    const type = /\bt="([^"]+)"/.exec(cell[1])?.[1];
    const raw = taggedText(cell[2], 'v') || taggedText(cell[2], 't');
    return type === 's' ? (strings[Number(raw)] ?? '') : raw;
  }).join('\t')).join('\n')).filter(Boolean).join('\n\n');
}

function extractRtf(source) {
  return source.replace(/\\u(-?\d+)\??/g, (_, value) => String.fromCodePoint((Number(value) + 65_536) % 65_536))
    .replace(/\\'([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\(?:par|line)\b ?/gi, '\n').replace(/\\tab\b ?/gi, '\t')
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/\\([{}\\])/g, '$1').replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function extractFallbackText(bytes, extension) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = source.toString('utf8').replace(/^\uFEFF/, '');
  if (extension === '.txt' || extension === '.csv') return text;
  if (extension === '.rtf') return extractRtf(text);
  if (extension === '.html' || extension === '.htm') return xmlText(text.replace(/<\/?(?:html|head|body|title)\b[^>]*>/gi, ''));
  if (['.doc', '.xls', '.ppt'].includes(extension)) throw new HostError('LEGACY_OFFICE_FORMAT_REQUIRES_LIBREOFFICE', 'This legacy Office format requires a working local LibreOffice engine.', 422);
  const entries = readZipEntries(source);
  if (extension === '.docx') return extractDocx(entries);
  if (extension === '.pptx') return extractPptx(entries);
  if (extension === '.xlsx') return extractXlsx(entries);
  if (['.odt', '.odp', '.ods'].includes(extension)) {
    const content = entries.get('content.xml');
    if (!content) throw new HostError('INVALID_OFFICE_ARCHIVE', 'The OpenDocument archive has no content.xml entry.', 422);
    return xmlText(content.toString('utf8'));
  }
  throw new HostError('UNSUPPORTED_INPUT_FORMAT', 'No deterministic text extractor is registered for this input.', 415);
}

export async function extractFallbackTextFile(path, extension) {
  return extractFallbackText(await readFile(path), extension);
}
