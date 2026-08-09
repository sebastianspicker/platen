import { basename, extname } from 'node:path';
import { TextDecoder } from 'node:util';
import { HostError } from './host-error.mjs';

const MAX_INLINE_HTML_BYTES = 8 * 1024 * 1024;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const PASSIVE_HTML_ELEMENTS = new Set([
  'html', 'head', 'body', 'title', 'main', 'section', 'article', 'header', 'footer',
  'div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'caption', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td',
]);

function decodeInlineHtml(buffer) {
  try {
    const html = utf8Decoder.decode(buffer);
    if (html.includes('\0')) throw new TypeError('NUL byte');
    return html;
  } catch {
    throw new HostError(
      'HTML_INVALID_ENCODING',
      'HTML conversion accepts valid UTF-8 text without NUL bytes.',
      422,
    );
  }
}

function tagEnd(html, start) {
  let quote = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

function isAttributeFreePassiveTag(tag) {
  if (/^<!doctype\s+html\s*>$/iu.test(tag)) return true;
  const opening = /^<([a-z][a-z0-9-]*)\s*\/?>$/iu.exec(tag);
  const closing = /^<\/([a-z][a-z0-9-]*)\s*>$/iu.exec(tag);
  const name = opening?.[1] ?? closing?.[1];
  return typeof name === 'string' && PASSIVE_HTML_ELEMENTS.has(name.toLowerCase());
}

function containsExternalOrActiveContent(html) {
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) return false;
    const end = tagEnd(html, start);
    if (end < 0 || !isAttributeFreePassiveTag(html.slice(start, end + 1))) return true;
    cursor = end + 1;
  }
  return false;
}

export function assertInlineOnlyHtml(buffer) {
  if (buffer.length > MAX_INLINE_HTML_BYTES) {
    throw new HostError(
      'HTML_TOO_LARGE',
      `Local HTML conversion is limited to ${MAX_INLINE_HTML_BYTES} bytes.`,
      413,
    );
  }
  const html = decodeInlineHtml(buffer);
  if (containsExternalOrActiveContent(html)) {
    throw new HostError(
      'HTML_EXTERNAL_CONTENT_FORBIDDEN',
      'HTML conversion accepts attribute-free passive markup only; active content and resource references are forbidden.',
      422,
    );
  }
}

export function cleanConversionStem(displayName) {
  return basename(displayName, extname(displayName))
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .slice(0, 120) || 'converted';
}

export function canUseTextFallback(asset, error, signal) {
  if (!['office', 'text', 'html'].includes(asset.kind) || signal?.aborted) return false;
  return ![
    'ENGINE_TIMEOUT', 'ENGINE_CANCELLED', 'ENGINE_QUEUE_FULL', 'ENGINE_HOST_UNHEALTHY',
  ].includes(error?.code);
}
