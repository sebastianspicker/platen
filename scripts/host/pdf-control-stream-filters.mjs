import { inflateSync } from 'node:zlib';
import { pdfInteger } from './pdf-classic-syntax.mjs';

const MAX_FILTER_WORK = 16 * 1024 * 1024;
const SPACE = new Set([0, 9, 10, 12, 13, 32]);

function invalid() { const error = new Error('PDF control stream filters are invalid.'); error.code = 'INVALID_PDF_CONTROL_STREAM_FILTER'; return error; }
function dictionary(value) { if (value?.type !== 'dict' || Object.getPrototypeOf(value.entries) !== Map.prototype) throw invalid(); return value.entries; }
function arrayValues(value) { if (value?.type !== 'array' || !Array.isArray(value.values) || Object.getPrototypeOf(value.values) !== Array.prototype) throw invalid(); return value.values; }
function flateParameters(value) {
  if (value?.type === 'null') return Object.freeze({ predictor: 1 });
  const entries = dictionary(value);
  if (entries.size === 0) return Object.freeze({ predictor: 1 });
  if ([...entries.keys()].some((key) => !['Predictor', 'Colors', 'BitsPerComponent', 'Columns'].includes(key))) throw invalid();
  const predictor = pdfInteger(entries.get('Predictor'));
  if (predictor === 1 && entries.size === 1) return Object.freeze({ predictor });
  if (predictor < 10 || predictor > 15) throw invalid();
  if (entries.has('Colors') && pdfInteger(entries.get('Colors')) !== 1) throw invalid();
  if (entries.has('BitsPerComponent') && pdfInteger(entries.get('BitsPerComponent')) !== 8) throw invalid();
  const columns = entries.has('Columns') ? pdfInteger(entries.get('Columns')) : 1; if (columns < 1 || columns > 65_536) throw invalid();
  return Object.freeze({ predictor, columns });
}
function parameters(value, filter) {
  if (filter === 'FlateDecode') return flateParameters(value);
  if (value?.type === 'null' || dictionary(value).size === 0) return null;
  throw invalid();
}

function pipeline(filterValue, decodeParmsValue) {
  let filters;
  if (filterValue === undefined) filters = [];
  else if (filterValue?.type === 'name') filters = [filterValue.value];
  else if (filterValue?.type === 'array') filters = arrayValues(filterValue).map((entry) => {
    if (entry?.type !== 'name') throw invalid(); return entry.value;
  });
  else throw invalid();
  const admitted = (filters.length === 0 && filterValue === undefined) || (filters.length === 1 && ['ASCIIHexDecode', 'ASCII85Decode', 'FlateDecode', 'RunLengthDecode'].includes(filters[0]))
    || (filters.length === 2 && ['ASCIIHexDecode', 'ASCII85Decode'].includes(filters[0]) && ['FlateDecode', 'RunLengthDecode'].includes(filters[1]));
  if (!admitted) throw invalid();
  if (decodeParmsValue === undefined || decodeParmsValue?.type === 'null') return Object.freeze(filters.map((name) => Object.freeze({ name, parameters: name === 'FlateDecode' ? Object.freeze({ predictor: 1 }) : null })));
  if (filterValue?.type === 'name') return Object.freeze([Object.freeze({ name: filters[0], parameters: parameters(decodeParmsValue, filters[0]) })]);
  const parameterValues = arrayValues(decodeParmsValue);
  if (filterValue?.type !== 'array' || parameterValues.length !== filters.length) throw invalid();
  return Object.freeze(filters.map((name, index) => Object.freeze({ name, parameters: parameters(parameterValues[index], name) })));
}

function charge(budget, scope, count) {
  if (!Number.isSafeInteger(count) || count < 0 || !budget || typeof budget !== 'object') throw invalid();
  const key = scope === 'xref' ? 'xrefFilterWorkBytes' : scope === 'object' ? 'objectFilterWorkBytes' : null;
  if (!key || !Number.isSafeInteger(budget[key]) || budget[key] < 0 || budget[key] + count > MAX_FILTER_WORK) throw invalid();
  budget[key] += count;
}
function remainingWork(budget, scope) {
  const key = scope === 'xref' ? 'xrefFilterWorkBytes' : scope === 'object' ? 'objectFilterWorkBytes' : null;
  if (!key || !budget || !Number.isSafeInteger(budget[key]) || budget[key] < 0 || budget[key] > MAX_FILTER_WORK) throw invalid();
  return MAX_FILTER_WORK - budget[key];
}
function hex(byte) { if (byte >= 48 && byte <= 57) return byte - 48; if (byte >= 65 && byte <= 70) return byte - 55; if (byte >= 97 && byte <= 102) return byte - 87; return -1; }
function asciiHex(source, maximum) {
  let digits = 0; let end = -1;
  for (let index = 0; index < source.length; index += 1) {
    const byte = source[index]; if (SPACE.has(byte)) continue;
    if (byte === 62) { end = index; break; }
    if (hex(byte) < 0) throw invalid(); digits += 1;
  }
  if (end < 0 || source.subarray(end + 1).some((byte) => !SPACE.has(byte))) throw invalid();
  const length = Math.ceil(digits / 2); if (length > maximum) throw invalid();
  const output = Buffer.allocUnsafe(length); let high = -1; let position = 0;
  for (let index = 0; index < end; index += 1) { const value = hex(source[index]); if (value < 0) continue; if (high < 0) high = value; else { output[position++] = (high << 4) | value; high = -1; } }
  if (high >= 0) output[position] = high << 4; return output;
}
function ascii85(source, maximum) {
  let digits = 0; let number = 0; let length = 0; let end = -1;
  for (let index = 0; index < source.length; index += 1) {
    const byte = source[index]; if (SPACE.has(byte)) continue;
    if (byte === 126 && source[index + 1] === 62) { end = index; break; }
    if (byte === 122) { if (digits) throw invalid(); length += 4; if (length > maximum) throw invalid(); continue; }
    if (byte < 33 || byte > 117) throw invalid(); number = (number * 85) + byte - 33;
    if (number > 0xffffffff) throw invalid(); digits += 1;
    if (digits === 5) { length += 4; if (length > maximum) throw invalid(); digits = 0; number = 0; }
  }
  if (end < 0 || source.subarray(end + 2).some((byte) => !SPACE.has(byte))) throw invalid();
  if (digits === 1) throw invalid(); const tailDigits = digits;
  while (digits > 0 && digits < 5) { number = (number * 85) + 84; if (number > 0xffffffff) throw invalid(); digits += 1; }
  if (tailDigits) { length += tailDigits - 1; if (length > maximum) throw invalid(); }
  const output = Buffer.allocUnsafe(length); let position = 0; digits = 0; number = 0;
  const write = (count) => {
    if (count > 0) output[position] = (number >>> 24) & 255;
    if (count > 1) output[position + 1] = (number >>> 16) & 255;
    if (count > 2) output[position + 2] = (number >>> 8) & 255;
    if (count > 3) output[position + 3] = number & 255;
    position += count;
  };
  for (let index = 0; index < end; index += 1) {
    const byte = source[index]; if (SPACE.has(byte)) continue;
    if (byte === 122) { output.fill(0, position, position + 4); position += 4; continue; }
    number = (number * 85) + byte - 33; digits += 1;
    if (digits === 5) { write(4); digits = 0; number = 0; }
  }
  if (digits) { const count = digits; while (digits < 5) { number = (number * 85) + 84; digits += 1; } write(count - 1); }
  return output;
}
function flate(source, maximum) {
  try { const result = inflateSync(source, { info: true, maxOutputLength: maximum + 1 }); if (result.engine.bytesWritten !== source.length || result.buffer.length > maximum) throw invalid(); return result.buffer; } catch (error) { if (error?.code === 'INVALID_PDF_CONTROL_STREAM_FILTER') throw error; throw invalid(); }
}
function runLength(source, maximum) {
  let decodedLength = 0; let index = 0; let ended = false;
  while (index < source.length) {
    const control = source[index++];
    if (control === 128) { ended = true; break; }
    const count = control <= 127 ? control + 1 : 257 - control;
    if (control <= 127) { if (index + count > source.length) throw invalid(); index += count; }
    else { if (index >= source.length) throw invalid(); index += 1; }
    decodedLength += count;
    if (!Number.isSafeInteger(decodedLength) || decodedLength > maximum) throw invalid();
  }
  if (!ended || index !== source.length) throw invalid();
  const output = Buffer.allocUnsafe(decodedLength); index = 0; let position = 0;
  while (source[index] !== 128) {
    const control = source[index++]; const count = control <= 127 ? control + 1 : 257 - control;
    if (control <= 127) { source.copy(output, position, index, index + count); index += count; }
    else { output.fill(source[index++], position, position + count); }
    position += count;
  }
  return output;
}
function paeth(left, up, upperLeft) { const estimate = left + up - upperLeft; const a = Math.abs(estimate - left); const b = Math.abs(estimate - up); const c = Math.abs(estimate - upperLeft); return a <= b && a <= c ? left : b <= c ? up : upperLeft; }
function pngPredictor(bytes, { predictor, columns }, maximum, shape) {
  const row = columns + 1; if (!Number.isSafeInteger(row) || bytes.length % row) throw invalid();
  const rows = bytes.length / row; if (shape && (shape.columns !== columns || shape.rows !== rows)) throw invalid();
  const length = rows * columns; if (!Number.isSafeInteger(length) || length > maximum) throw invalid();
  for (let index = 0; index < bytes.length; index += row) if (bytes[index] > 4) throw invalid();
  const output = Buffer.allocUnsafe(length); let input = 0; let position = 0;
  while (input < bytes.length) { const method = bytes[input++]; if (method > 4) throw invalid(); for (let column = 0; column < columns; column += 1) { const raw = bytes[input++]; const left = column ? output[position - 1] : 0; const up = position >= columns ? output[position - columns] : 0; const upperLeft = column && position >= columns ? output[position - columns - 1] : 0; output[position++] = method === 0 ? raw : method === 1 ? (raw + left) & 255 : method === 2 ? (raw + up) & 255 : method === 3 ? (raw + Math.floor((left + up) / 2)) & 255 : (raw + paeth(left, up, upperLeft)) & 255; } }
  return Object.freeze({ bytes: output, predictor: Object.freeze({ kind: 'png', declared: predictor, columns, colors: 1, bitsPerComponent: 8 }) });
}

function decode({ encodedBytes, filterValue, decodeParmsValue, scope, maximumDecodedBytes, budget, predictorShape } = {}) {
  if (!Buffer.isBuffer(encodedBytes) || !Number.isSafeInteger(maximumDecodedBytes) || maximumDecodedBytes < 0) throw invalid();
  const stages = pipeline(filterValue, decodeParmsValue); const filters = Object.freeze(stages.map(({ name }) => name)); let bytes = encodedBytes; let predictor = null;
  if (filters.length === 0 && bytes.length > maximumDecodedBytes) throw invalid();
  stages.forEach(({ name, parameters: flateParameters }, index) => {
    const work = remainingWork(budget, scope);
    let maximum = index === filters.length - 1 ? Math.min(maximumDecodedBytes, work) : work;
    const png = name === 'FlateDecode' && flateParameters.predictor > 1;
    if (png && predictorShape) {
      if (!Number.isSafeInteger(predictorShape.columns) || !Number.isSafeInteger(predictorShape.rows) || predictorShape.columns < 1 || predictorShape.rows < 1 || predictorShape.columns !== flateParameters.columns) throw invalid();
      if (predictorShape.rows > Math.floor(work / ((2 * flateParameters.columns) + 1)) || predictorShape.rows > Math.floor(maximumDecodedBytes / flateParameters.columns)) throw invalid();
      maximum = predictorShape.rows * (flateParameters.columns + 1);
    } else if (png) { const rows = Math.min(Math.floor(work / ((2 * flateParameters.columns) + 1)), Math.floor(maximumDecodedBytes / flateParameters.columns)); maximum = rows * (flateParameters.columns + 1); }
    bytes = name === 'ASCIIHexDecode' ? asciiHex(bytes, maximum) : name === 'ASCII85Decode' ? ascii85(bytes, maximum) : name === 'RunLengthDecode' ? runLength(bytes, maximum) : flate(bytes, maximum);
    if (png) { const inflated = bytes; const reconstructed = pngPredictor(inflated, flateParameters, maximumDecodedBytes, predictorShape); bytes = reconstructed.bytes; predictor = reconstructed.predictor; charge(budget, scope, inflated.length); charge(budget, scope, bytes.length); } else charge(budget, scope, bytes.length);
  });
  return Object.freeze({ bytes, filters, ...(predictor ? { predictor } : {}) });
}

export function decodePdfControlStream(request = {}) {
  try { return decode(request); } catch (error) { if (error?.code === 'INVALID_PDF_CONTROL_STREAM_FILTER') throw error; throw invalid(); }
}
