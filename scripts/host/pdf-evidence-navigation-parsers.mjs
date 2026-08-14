import { HostError } from './host-error.mjs';
import {
  MAX_DESTINATION_NAME_BYTES,
  MAX_NAMED_DESTINATIONS,
  MAX_PAGE_COUNT,
  MAX_RAW_DESTINATION_BYTES,
} from './pdf-service-limits.mjs';

function invalidOutput(message) {
  return new HostError('INVALID_ENGINE_OUTPUT', message, 502);
}

function assertValidPageCount(pageCount) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGE_COUNT) {
    throw invalidOutput('A valid document page count is required for named destinations.');
  }
}

function assertTextOutput(output) {
  if (typeof output !== 'string') {
    throw invalidOutput('Poppler named-destination output must be text.');
  }
  for (const character of output) {
    const codePoint = character.codePointAt(0);
    if ((codePoint <= 0x1f && codePoint !== 0x0a && codePoint !== 0x0d)
      || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      throw invalidOutput('Poppler named-destination output contains a control byte.');
    }
  }
}

function parseDestinationLine(line, pageCount) {
  const match = line.match(/^ *(\d+) +(.+?) +("(?:[^"\\\r\n]|\\.)*") *$/u);
  if (!match) throw invalidOutput('Poppler reported a malformed named destination.');
  const page = Number.parseInt(match[1], 10);
  const destination = match[2];
  const name = match[3].slice(1, -1);
  if (!Number.isSafeInteger(page) || page < 1 || page > pageCount || !destination.trim()
    || !name || Buffer.byteLength(destination, 'utf8') > MAX_RAW_DESTINATION_BYTES
    || Buffer.byteLength(name, 'utf8') > MAX_DESTINATION_NAME_BYTES) {
    throw invalidOutput('Poppler reported an invalid named destination.');
  }
  return Object.freeze({ page, destination, name });
}

export function parseNamedDestinations(output, { pageCount } = {}) {
  assertValidPageCount(pageCount);
  assertTextOutput(output);
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== 'Page  Destination                 Name') {
    throw invalidOutput('Poppler did not report the named-destination header.');
  }
  const items = [];
  let truncated = false;
  for (const line of lines.slice(1)) {
    const item = parseDestinationLine(line, pageCount);
    if (items.length < MAX_NAMED_DESTINATIONS) items.push(item);
    else truncated = true;
  }
  return Object.freeze({ items: Object.freeze(items), truncated });
}

export function parseDocumentUrls(output) {
  const records = [];
  for (const line of String(output ?? '').split(/\r?\n/).slice(1)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (match) {
      records.push(Object.freeze({
        page: Number.parseInt(match[1], 10), type: match[2], url: match[3],
      }));
    }
  }
  return Object.freeze(records);
}
