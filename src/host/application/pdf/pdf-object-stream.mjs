import { decodePdfControlStream } from './pdf-control-stream-filters.mjs';
import { parsePdfValueSlice, pdfDictionary, pdfInteger } from './pdf-classic-syntax.mjs';

const MAX_VERSIONS = 256;
const MAX_MEMBERS = 10_000;
const MAX_ENCODED_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const ALLOWED_KEYS = new Set(['Type', 'N', 'First', 'Length', 'Filter', 'DecodeParms']);

function invalid() {
  const error = new Error('PDF object stream is malformed or unsupported.');
  error.code = 'INVALID_PDF_OBJECT_STREAM';
  return error;
}

function objectBytes(object) {
  return object.buffer.subarray(object.streamStart, object.streamStart + object.streamLength);
}

function checkedDictionary(object) {
  if (!object?.stream || !Buffer.isBuffer(object.buffer)) throw invalid();
  const entries = pdfDictionary(object.value);
  if ([...entries.keys()].some((key) => !ALLOWED_KEYS.has(key))
    || entries.get('Type')?.type !== 'name' || entries.get('Type').value !== 'ObjStm') throw invalid();
  const count = pdfInteger(entries.get('N')); const first = pdfInteger(entries.get('First'));
  const length = pdfInteger(entries.get('Length'));
  if (count < 1 || count > MAX_MEMBERS || first < 1 || length < 0
    || length !== object.streamLength) throw invalid();
  return { count, first, filter: entries.get('Filter'), decodeParms: entries.get('DecodeParms') };
}

function decoded(object, controls, budget) {
  const raw = objectBytes(object);
  if (raw.length > MAX_ENCODED_BYTES || !Number.isSafeInteger(budget.objectStreamEncodedBytes)
    || !Number.isSafeInteger(budget.objectStreamDecodedBytes)) throw invalid();
  budget.objectStreamEncodedBytes += raw.length;
  if (budget.objectStreamEncodedBytes > MAX_TOTAL_BYTES) throw invalid();
  const decodedStream = decodePdfControlStream({ encodedBytes: raw, filterValue: controls.filter, decodeParmsValue: controls.decodeParms, scope: 'object', maximumDecodedBytes: MAX_TOTAL_BYTES - budget.objectStreamDecodedBytes, budget }); const { bytes } = decodedStream;
  budget.objectStreamDecodedBytes += bytes.length;
  if (budget.objectStreamDecodedBytes > MAX_TOTAL_BYTES || controls.first >= bytes.length) throw invalid();
  return Object.freeze({ bytes, filters: decodedStream.filters, predictor: decodedStream.predictor ?? null });
}

function directory(bytes, count, first) {
  const source = bytes.subarray(0, first).toString('latin1');
  if (!/^[\x00\x09\x0a\x0c\x0d\x20]*\d+(?:[\x00\x09\x0a\x0c\x0d\x20]+\d+){1}(?:[\x00\x09\x0a\x0c\x0d\x20]+\d+[\x00\x09\x0a\x0c\x0d\x20]+\d+){0,9999}[\x00\x09\x0a\x0c\x0d\x20]*$/u.test(source)) throw invalid();
  const tokens = source.trim().split(/[\x00\x09\x0a\x0c\x0d\x20]+/u).map(Number);
  if (tokens.length !== count * 2 || tokens.some((value) => !Number.isSafeInteger(value) || value < 0)) throw invalid();
  const members = []; const numbers = new Set();
  for (let index = 0; index < count; index += 1) {
    const object = tokens[index * 2]; const offset = tokens[(index * 2) + 1];
    if (object < 1 || numbers.has(object) || (index === 0 && offset !== 0)
      || (index > 0 && offset <= members[index - 1].offset) || first + offset >= bytes.length) throw invalid();
    numbers.add(object); members.push({ object, offset });
  }
  return members;
}

export function parsePdfObjectStream(object, sharedBudget = null) {
  try {
    const budget = sharedBudget ?? { objectStreamVersions: 0, objectStreamEncodedBytes: 0, objectStreamDecodedBytes: 0, objectFilterWorkBytes: 0, items: 0, decodedBytes: 0 };
    if (budget.objectFilterWorkBytes === undefined) budget.objectFilterWorkBytes = 0;
    if (!Number.isSafeInteger(budget.objectStreamVersions) || budget.objectStreamVersions < 0) throw invalid();
    budget.objectStreamVersions += 1;
    if (budget.objectStreamVersions > MAX_VERSIONS) throw invalid();
    const controls = checkedDictionary(object); const decodedStream = decoded(object, controls, budget); const { bytes } = decodedStream;
    const members = directory(bytes, controls.count, controls.first);
    const values = members.map((member, index) => {
      const end = index + 1 < members.length ? controls.first + members[index + 1].offset : bytes.length;
      const value = parsePdfValueSlice(bytes, controls.first + member.offset, end, budget);
      return Object.freeze({
        object: member.object, index, value, stream: false,
        decodedStart: controls.first + member.offset, decodedEnd: end,
        filter: decodedStream.filters.length ? decodedStream.filters.join('+') : 'identity',
        ...(decodedStream.predictor ? { predictor: decodedStream.predictor } : {}),
      });
    });
    return Object.freeze(values);
  } catch (error) {
    if (error?.code === 'INVALID_PDF_OBJECT_STREAM') throw error;
    throw invalid();
  }
}
