import { fail } from './support.mjs';

const XFDF_LIMITS = Object.freeze({ maxBytes: 16 * 1024, maxContents: 500, maxName: 128 });
const NUMBER_SOURCE = '-?(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?';
const MAX_PAGE_INDEX = 9_998;
const MAX_COORDINATE = 1_000_000;
const DOCUMENT = new RegExp(
  `^<\\?xml version="1\\.0" encoding="UTF-8"\\?>\\n<xfdf xmlns="http://ns\\.adobe\\.com/xfdf/" xml:space="preserve"><annots><text page="(0|[1-9]\\d{0,3})" rect="(${NUMBER_SOURCE}),(${NUMBER_SOURCE}),(${NUMBER_SOURCE}),(${NUMBER_SOURCE})"(?: name="([^"<>]*)")?><contents>([^<]*)</contents></text></annots></xfdf>\\n$`,
  'u',
);
const ENTITY = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});
const BANNED_PATTERNS = /<!DOCTYPE|<!ENTITY|<\?|<!--|<!\[CDATA\[/iu;
const UNSAFE_CHARACTER = /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u;

function invalid(message = 'XFDF is outside the canonical Text annotation subset.') {
  fail('INVALID_ANNOTATION_XFDF', message, 400);
}

function decodeXmlText(value) {
  let decoded = '';
  let cursor = 0;
  while (cursor < value.length) {
    const ampStart = value.indexOf('&', cursor);
    if (ampStart < 0) {
      decoded += value.slice(cursor);
      break;
    }
    decoded += value.slice(cursor, ampStart);
    const ampEnd = value.indexOf(';', ampStart + 1);
    if (ampEnd < 0) invalid('XFDF contains malformed entity encoding.');
    const replacement = ENTITY[value.slice(ampStart + 1, ampEnd)];
    if (replacement === undefined) invalid('XFDF contains an unsupported entity reference.');
    decoded += replacement;
    cursor = ampEnd + 1;
  }
  return decoded;
}

function assertSafeText(value, label, maximum) {
  if (!value || Buffer.byteLength(value, 'utf8') > maximum || UNSAFE_CHARACTER.test(value)) {
    invalid(`${label} is outside the fixed text bound.`);
  }
  return value;
}

function assertPage(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PAGE_INDEX) {
    invalid('XFDF page is outside the fixed bound.');
  }
  return value;
}

function canonicalNumber(value) {
  return Object.is(value, -0) ? '0' : String(value);
}

function escapeXml(value) {
  return value.replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function parseCanonicalTextAnnotationXfdf(xfdf) {
  if (typeof xfdf !== 'string' || Buffer.byteLength(xfdf, 'utf8') > XFDF_LIMITS.maxBytes) {
    invalid('XFDF must be a UTF-8 string within the fixed byte bound.');
  }
  if (BANNED_PATTERNS.test(xfdf.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/u, ''))) {
    invalid('Declarations, entities, processing instructions, comments, and CDATA are not admitted.');
  }
  const match = DOCUMENT.exec(xfdf);
  if (!match) invalid();

  const pageIndex = assertPage(Number(match[1]));
  const rect = match.slice(2, 6).map(Number);
  if (rect.some((value) => !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE)
    || !(rect[2] > rect[0] && rect[3] > rect[1])) {
    invalid('XFDF page or rectangle is outside the fixed annotation bound.');
  }

  const name = match[6] === undefined
    ? undefined
    : assertSafeText(decodeXmlText(match[6]), 'XFDF annotation name', XFDF_LIMITS.maxName);
  const contents = assertSafeText(
    decodeXmlText(match[7]),
    'XFDF annotation contents',
    XFDF_LIMITS.maxContents,
  );
  return Object.freeze({
    subtype: 'Text',
    page: pageIndex + 1,
    rect: Object.freeze(rect),
    contents,
    ...(name === undefined ? {} : { name }),
  });
}

export function exportCanonicalTextAnnotationXfdf(record) {
  if (!record || typeof record !== 'object') invalid('XFDF record must be an object.');
  if (record.subtype !== 'Text') invalid('Only Text annotations are supported.');
  const contents = assertSafeText(
    String(record.contents),
    'XFDF annotation contents',
    XFDF_LIMITS.maxContents,
  );
  const pageIndex = assertPage(Number(record.page) - 1);
  const rect = Array.isArray(record.rect) && record.rect.length === 4
    ? record.rect
    : invalid('XFDF page or rectangle is outside the fixed annotation bound.');
  if (rect.some((value) => !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE)
    || !(rect[2] > rect[0] && rect[3] > rect[1])) {
    invalid('XFDF page or rectangle is outside the fixed annotation bound.');
  }
  const name = record.name === undefined
    ? ''
    : ` name="${escapeXml(assertSafeText(String(record.name), 'XFDF annotation name', XFDF_LIMITS.maxName))}"`;
  const rectCanonical = rect.map(canonicalNumber).join(',');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots><text page="${pageIndex}" rect="${rectCanonical}"${name}><contents>${escapeXml(contents)}</contents></text></annots></xfdf>\n`;
}
