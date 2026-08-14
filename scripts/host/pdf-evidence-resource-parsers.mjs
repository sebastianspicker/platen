import { HostError } from './host-error.mjs';

function parseTable(output, headerPattern, parseRow) {
  const lines = dataLines(output);
  const header = lines.findIndex((line) => headerPattern.test(line));
  if (header === -1) return Object.freeze([]);
  return Object.freeze(lines.slice(header + 1).map(parseRow));
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function invalidResourceRow(kind) {
  throw new HostError('INVALID_ENGINE_OUTPUT', `Poppler returned an invalid ${kind} inventory row.`, 502);
}

function boundedText(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value === value.trim() && !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(value);
}

function strictInteger(value, minimum, maximum) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = parseInteger(value);
  return parsed !== null && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function ppi(value) {
  if (value === '0' || value === '-' || value === '?') return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : undefined;
}

export function dataLines(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^[-\s]+$/.test(line));
}

export function parseFonts(output) {
  return parseTable(output, /^name\s+type\s+encoding/i, (line) => {
    const columns = line.trim().split(/\s{2,}/);
    const tail = columns.length === 7 ? columns[6].split(/\s+/) : columns.slice(6);
    if ((columns.length !== 7 && columns.length !== 8) || tail.length !== 2 || !columns.slice(0, 3).every((value) => boundedText(value))
      || !columns.slice(3, 6).every((value) => value === 'yes' || value === 'no')
      || strictInteger(tail[0], 1, 1_000_000) === null
      || strictInteger(tail[1], 0, 65_535) === null) invalidResourceRow('font');
    return Object.freeze({
      name: columns[0], type: columns[1], encoding: columns[2],
      embedded: columns[3], subset: columns[4], unicode: columns[5],
    });
  });
}

export function parseImages(output) {
  return parseTable(output, /^page\s+num\s+type/i, (line) => {
    const columns = line.trim().split(/\s+/);
    if (columns.length !== 16 || ![2, 5, 8].every((index) => boundedText(columns[index], 128))) {
      invalidResourceRow('image');
    }
    const page = strictInteger(columns[0], 1, 1_000_000);
    const number = strictInteger(columns[1], 0, 1_000_000);
    const width = strictInteger(columns[3], 1, 1_000_000);
    const height = strictInteger(columns[4], 1, 1_000_000);
    const components = strictInteger(columns[6], 1, 64);
    const bitsPerComponent = strictInteger(columns[7], 1, 64);
    const objectId = strictInteger(columns[10], 1, 1_000_000);
    const generation = strictInteger(columns[11], 0, 65_535);
    const xPpi = ppi(columns[12]);
    const yPpi = ppi(columns[13]);
    if ([page, number, width, height, components, bitsPerComponent, objectId, generation].some((value) => value === null)
      || xPpi === undefined || yPpi === undefined) invalidResourceRow('image');
    return Object.freeze({
      page, number, type: columns[2], width, height, color: columns[5],
      bitsPerComponent, encoding: columns[8], objectId, generation, xPpi, yPpi,
    });
  });
}

export function parseAttachments(output) {
  const attachments = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s*:\s*(.+?)\s*$/);
    if (match) {
      attachments.push(Object.freeze({
        number: Number.parseInt(match[1], 10), name: match[2],
      }));
    }
  }
  return Object.freeze(attachments);
}
