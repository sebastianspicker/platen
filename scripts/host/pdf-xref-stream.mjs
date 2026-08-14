import { decodePdfControlStream } from './pdf-control-stream-filters.mjs';
import {
  parsePdfIndirectObject,
  pdfDictionary,
  pdfInteger,
} from './pdf-classic-syntax.mjs';

const MAX_XREF_ROWS = 50_000;
const MAX_DECODED_XREF_BYTES = 8 * 1024 * 1024;
const MAX_ENCODED_XREF_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ENCODED_XREF_BYTES = 8 * 1024 * 1024;
const ALLOWED_KEYS = new Set(['Type', 'W', 'Index', 'Size', 'Root', 'Info', 'ID', 'Prev', 'Length', 'Filter', 'DecodeParms']);

function invalid() {
  const error = new Error('PDF xref stream is malformed or unsupported.');
  error.code = 'INVALID_PDF_XREF_STREAM';
  return error;
}

function referenceAt(buffer, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= buffer.length
    || (offset > 0 && buffer[offset - 1] !== 10 && buffer[offset - 1] !== 13)) throw invalid();
  const match = /^(\d+)\x20(\d+)\x20obj(?:\x00|\x09|\x0a|\x0c|\x0d|\x20)/.exec(buffer.subarray(offset, offset + 48).toString('latin1'));
  const object = Number(match?.[1]); const generation = Number(match?.[2]);
  if (!Number.isSafeInteger(object) || object < 1 || !Number.isSafeInteger(generation)
    || generation < 0 || generation > 65_535) throw invalid();
  return Object.freeze({ object, generation });
}

function integerArray(value, length, minimum = 0) {
  const entries = value?.type === 'array' ? value.values : null;
  if (!entries || entries.length !== length) throw invalid();
  return entries.map((entry) => {
    const number = pdfInteger(entry);
    if (number < minimum) throw invalid();
    return number;
  });
}

function readUnsigned(bytes, start, width) {
  let value = 0;
  for (let index = 0; index < width; index += 1) {
    value = (value * 256) + bytes[start + index];
    if (!Number.isSafeInteger(value)) throw invalid();
  }
  return value;
}

function decodedBytes(object, dictionary, expectedLength, sharedBudget, predictorShape) {
  const raw = object.streamLength === 0 ? Buffer.alloc(0) : objectBuffer(object);
  if (raw.length > MAX_ENCODED_XREF_BYTES) throw invalid();
  const budget = sharedBudget ?? {};
  if (budget.xrefFilterWorkBytes === undefined) budget.xrefFilterWorkBytes = 0;
  if (!Number.isSafeInteger(budget.xrefEncodedBytes ?? 0) || (budget.xrefEncodedBytes ?? 0) < 0) throw invalid();
  budget.xrefEncodedBytes = (budget.xrefEncodedBytes ?? 0) + raw.length;
  if (budget.xrefEncodedBytes > MAX_TOTAL_ENCODED_XREF_BYTES) throw invalid();
  return decodePdfControlStream({ encodedBytes: raw, filterValue: dictionary.get('Filter'), decodeParmsValue: dictionary.get('DecodeParms'), scope: 'xref', maximumDecodedBytes: expectedLength, budget, predictorShape }).bytes;
}

function objectBuffer(object) {
  return object.buffer.subarray(object.streamStart, object.streamStart + object.streamLength);
}

export function parseXrefStreamSection(buffer, offset, sharedBudget = null) {
  try {
    if (!Buffer.isBuffer(buffer)) throw invalid();
    const reference = referenceAt(buffer, offset);
    const parsed = parsePdfIndirectObject(buffer, offset, reference, sharedBudget);
    const object = Object.freeze({ ...parsed, buffer });
    if (!object.stream) throw invalid();
    const trailer = pdfDictionary(object.value);
    if ([...trailer.keys()].some((key) => !ALLOWED_KEYS.has(key))
      || trailer.get('Type')?.type !== 'name' || trailer.get('Type').value !== 'XRef'
      || trailer.has('Encrypt') || trailer.has('XRefStm')) throw invalid();
    const size = pdfInteger(trailer.get('Size'));
    if (size < 1 || size > 1_000_000) throw invalid();
    const widths = integerArray(trailer.get('W'), 3);
    if (widths.some((width) => width > 8)) throw invalid();
    const rowWidth = widths.reduce((total, width) => total + width, 0);
    if (rowWidth < 1 || rowWidth > 24) throw invalid();
    const index = trailer.has('Index') ? integerArray(trailer.get('Index'), trailer.get('Index').values.length) : [0, size];
    if (index.length < 2 || index.length % 2 !== 0) throw invalid();
    let rows = 0; let priorEnd = -1;
    for (let item = 0; item < index.length; item += 2) {
      const first = index[item]; const count = index[item + 1];
      if (count < 1 || first >= size || first + count > size || first <= priorEnd) throw invalid();
      priorEnd = first + count - 1; rows += count;
    }
    if (rows > MAX_XREF_ROWS) throw invalid();
    const expectedLength = rows * rowWidth;
    if (expectedLength > MAX_DECODED_XREF_BYTES) throw invalid();
    const bytes = decodedBytes(object, trailer, expectedLength, sharedBudget, { columns: rowWidth, rows });
    if (bytes.length !== rows * rowWidth) throw invalid();
    const entries = []; let position = 0; let self = null;
    for (let item = 0; item < index.length; item += 2) {
      for (let objectNumber = index[item]; objectNumber < index[item] + index[item + 1]; objectNumber += 1) {
        const type = widths[0] === 0 ? 1 : readUnsigned(bytes, position, widths[0]); position += widths[0];
        const field2 = readUnsigned(bytes, position, widths[1]); position += widths[1];
        const field3 = readUnsigned(bytes, position, widths[2]); position += widths[2];
        if (![0, 1, 2].includes(type) || field3 > 65_535) throw invalid();
        if (type === 0 && (field2 >= size || (objectNumber === 0 && field3 !== 65_535))) throw invalid();
        if (type === 1 && (objectNumber === 0 || field2 >= buffer.length)) throw invalid();
        if (type === 2 && (objectNumber === 0 || field2 < 1 || field2 >= size || field3 > 9_999)) throw invalid();
        const entry = type === 2
          ? Object.freeze({ xrefType: 2, object: objectNumber, status: 'c', objectStream: field2, index: field3, generation: 0 })
          : Object.freeze({ object: objectNumber, generation: field3, offset: field2, status: type === 1 ? 'n' : 'f' });
        if (type === 1 && objectNumber === reference.object) {
          if (field2 !== offset || field3 !== reference.generation) throw invalid();
          self = entry;
        } else if (type === 1) {
          if (field2 >= offset) throw invalid();
          const physical = referenceAt(buffer, field2);
          if (physical.object !== objectNumber || physical.generation !== field3) throw invalid();
        }
        entries.push(entry);
      }
    }
    if (!self) throw invalid();
    let end = object.end;
    while (end < buffer.length && [0, 9, 10, 12, 13, 32].includes(buffer[end])) end += 1;
    if (end === 0 || (buffer[end - 1] !== 10 && buffer[end - 1] !== 13)) throw invalid();
    const tail = /^startxref[\x00\x09\x0a\x0c\x0d\x20]+(\d+)[\x00\x09\x0a\x0c\x0d\x20]+%%EOF[\x00\x09\x0a\x0c\x0d\x20]*/.exec(buffer.subarray(end).toString('latin1'));
    if (!tail || Number(tail[1]) !== offset) throw invalid();
    return Object.freeze({ offset, entries: Object.freeze(entries), trailer, size, revisionEnd: end + tail[0].length, xrefObject: object, xrefReference: reference });
  } catch (error) {
    if (error?.code === 'INVALID_PDF_XREF_STREAM') throw error;
    throw invalid();
  }
}
