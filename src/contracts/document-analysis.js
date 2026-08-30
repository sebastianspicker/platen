function isWordCharacter(value) {
  return typeof value === 'string' && value.length > 0 && /[\p{L}\p{N}_]/u.test(value);
}

export function searchTextPages(pages, query, {
  limit = 200,
  context = 54,
  caseSensitive = false,
  wholeWord = false,
} = {}) {
  const needle = String(query ?? '').trim();
  if (!needle) return Object.freeze([]);
  if (!Array.isArray(pages)) return Object.freeze([]);
  const maximumResults = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 200;
  const contextLength = Number.isSafeInteger(context) && context >= 0 ? Math.min(context, 500) : 54;
  const foldedNeedle = caseSensitive ? needle : needle.toLocaleLowerCase();
  const results = [];
  for (const page of pages) {
    const text = String(page?.text ?? '');
    const folded = caseSensitive ? text : text.toLocaleLowerCase();
    let offset = 0;
    let pageMatch = 0;
    while (results.length < maximumResults) {
      const index = folded.indexOf(foldedNeedle, offset);
      if (index === -1) break;
      const afterIndex = index + needle.length;
      if (wholeWord && (isWordCharacter(text[index - 1]) || isWordCharacter(text[afterIndex]))) {
        offset = index + Math.max(needle.length, 1);
        continue;
      }
      const start = Math.max(0, index - contextLength);
      const end = Math.min(text.length, afterIndex + contextLength);
      results.push(Object.freeze({
        id: `${page.page}:${index}:${pageMatch}`,
        page: Number(page.page) || 1,
        index,
        before: text.slice(start, index).replace(/\s+/g, ' ').trimStart(),
        match: text.slice(index, index + needle.length),
        after: text.slice(index + needle.length, end).replace(/\s+/g, ' ').trimEnd(),
      }));
      pageMatch += 1;
      offset = index + Math.max(needle.length, 1);
    }
    if (results.length >= maximumResults) break;
  }
  return Object.freeze(results);
}

export function textExport(pages) {
  return (Array.isArray(pages) ? pages : [])
    .map(({ page, text }) => `--- Page ${page} ---\n${String(text ?? '').trimEnd()}`)
    .join('\n\n');
}

function markupEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlEscape(value, { attribute = false, trimEnd = false } = {}) {
  const source = String(value ?? '');
  for (const character of source) {
    const codePoint = character.codePointAt(0);
    const valid = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!valid) throw new TypeError('XML text export contains a character forbidden by XML 1.0.');
  }
  let escaped = (trimEnd ? source.trimEnd() : source)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
  escaped = escaped.replaceAll('\r', '&#13;');
  if (attribute) escaped = escaped.replaceAll('\t', '&#9;').replaceAll('\n', '&#10;');
  return escaped;
}

function rtfEscape(value) {
  let result = '';
  for (const character of String(value ?? '')) {
    if (character === '\\' || character === '{' || character === '}') {
      result += `\\${character}`;
    } else if (character === '\n') {
      result += '\\line\n';
    } else {
      for (let index = 0; index < character.length; index += 1) {
        const unit = character[index];
        const code = character.charCodeAt(index);
        if (code >= 0x20 && code <= 0x7e) result += unit;
        else result += `\\u${code > 0x7fff ? code - 0x10000 : code}?`;
      }
    }
  }
  return result;
}

export function structuredTextExport(pages, format = 'text', { title = 'PDF text export' } = {}) {
  const source = Array.isArray(pages)
    ? pages.map(({ page, text }) => Object.freeze({ page: Number(page) || 1, text: String(text ?? '') }))
    : [];
  if (format === 'text') {
    return Object.freeze({ data: textExport(source), mediaType: 'text/plain;charset=utf-8', extension: 'txt' });
  }
  if (format === 'rtf') {
    const body = source.map(({ page, text }) => `\\b Page ${page}\\b0\\line\n${rtfEscape(text.trimEnd())}`).join('\\page\n');
    return Object.freeze({ data: `{\\rtf1\\ansi\\deff0\n${body}\n}`, mediaType: 'application/rtf', extension: 'rtf' });
  }
  if (format === 'html') {
    const body = source.map(({ page, text }) => `<section data-page="${page}"><h2>Page ${page}</h2><pre>${markupEscape(text.trimEnd())}</pre></section>`).join('\n');
    return Object.freeze({
      data: `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${markupEscape(title)}</title></head><body>\n${body}\n</body></html>\n`,
      mediaType: 'text/html;charset=utf-8',
      extension: 'html',
    });
  }
  if (format === 'xml') {
    const body = source.map(({ page, text }) => `  <page number="${page}">${xmlEscape(text, { trimEnd: true })}</page>`).join('\n');
    return Object.freeze({
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<document title="${xmlEscape(title, { attribute: true })}">\n${body}\n</document>\n`,
      mediaType: 'application/xml;charset=utf-8',
      extension: 'xml',
    });
  }
  throw new TypeError('Text export format must be text, rtf, html, or xml.');
}
