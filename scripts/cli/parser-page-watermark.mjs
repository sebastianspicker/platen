import { boundedPath, exactPositionals, fail } from './parser-foundation.mjs';
import { parseBoundedPageSpec } from './parser-full-page-redaction.mjs';
import { PDF_PAGE_WATERMARK_LIMITS } from '../host/pdf-page-watermark-contract.mjs';

function watermarkText(value) {
  if (typeof value !== 'string'
    || value.length < 1
    || value !== value.normalize('NFC')
    || [...value].length > PDF_PAGE_WATERMARK_LIMITS.maxTextCodePoints
    || Buffer.byteLength(value, 'utf8') > PDF_PAGE_WATERMARK_LIMITS.maxTextBytes
    || !/^[\x20-\x7E]*$/u.test(value)) {
    fail('CLI_INVALID_OPTION', '--text must be bounded, NFC-normalized printable ASCII.');
  }
  return value;
}

export function parsePageWatermark(command, positionals, values, output) {
  const [input] = exactPositionals(positionals, 1);
  if (!/\.pdf$/iu.test(input)) {
    fail('CLI_INVALID_OPTION', 'page-watermark accepts one .pdf input.');
  }
  if (!values.has('pages') || !values.has('text') || !output || !/\.pdf$/iu.test(output)) {
    fail('CLI_INVALID_OPTION', 'page-watermark requires --pages, --text, and a .pdf --output.');
  }
  return Object.freeze({
    command,
    input,
    pages: parseBoundedPageSpec(
      values.get('pages'),
      PDF_PAGE_WATERMARK_LIMITS.maxPages,
      PDF_PAGE_WATERMARK_LIMITS.maxPages,
    ),
    text: watermarkText(values.get('text')),
    output: boundedPath(output, 'Output'),
  });
}

