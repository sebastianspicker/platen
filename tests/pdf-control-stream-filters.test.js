import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { decodePdfControlStream } from '../scripts/host/pdf-control-stream-filters.mjs';

const name = (value) => ({ type: 'name', value });
const nil = { type: 'null' };
const dict = (entries = []) => ({ type: 'dict', entries: new Map(entries) });
const array = (values) => ({ type: 'array', values });
const number = (value) => ({ type: 'number', value, integer: true, raw: String(value) });
const budget = () => ({ xrefFilterWorkBytes: 0, objectFilterWorkBytes: 0 });
function ascii85(bytes) {
  let output = ''; for (let offset = 0; offset < bytes.length; offset += 4) { const count = Math.min(4, bytes.length - offset); let value = 0; for (let index = 0; index < 4; index += 1) value = (value * 256) + (bytes[offset + index] ?? 0); const encoded = Array(5); for (let index = 4; index >= 0; index -= 1) { encoded[index] = String.fromCharCode((value % 85) + 33); value = Math.floor(value / 85); } output += encoded.join('').slice(0, count + 1); } return Buffer.from(`${output}~>`, 'latin1');
}
function runLength(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 128) {
    const count = Math.min(128, bytes.length - offset);
    chunks.push(Buffer.from([count - 1]), bytes.subarray(offset, offset + count));
  }
  return Buffer.concat([...chunks, Buffer.from([128])]);
}
function paeth(left, up, upperLeft) { const value = left + up - upperLeft; const a = Math.abs(value - left); const b = Math.abs(value - up); const c = Math.abs(value - upperLeft); return a <= b && a <= c ? left : b <= c ? up : upperLeft; }
function pngRows(actual, columns, methods) { const rows = []; for (let offset = 0, row = 0; offset < actual.length; offset += columns, row += 1) { const method = methods[row]; const raw = Buffer.alloc(columns); for (let column = 0; column < columns; column += 1) { const value = actual[offset + column]; const left = column ? actual[offset + column - 1] : 0; const up = offset ? actual[offset - columns + column] : 0; const upperLeft = offset && column ? actual[offset - columns + column - 1] : 0; const base = method === 0 ? 0 : method === 1 ? left : method === 2 ? up : method === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft); raw[column] = (value - base) & 255; } rows.push(Buffer.concat([Buffer.from([method]), raw])); } return Buffer.concat(rows); }

test('control filters decode identity, ASCII, Flate, RunLength, and admitted chains', () => {
  const plain = Buffer.from('control bytes', 'latin1'); const compressed = deflateSync(plain);
  const cases = [
    [{}, plain], [{ filterValue: name('ASCIIHexDecode') }, Buffer.from('636F6E74726F6C206279746573>', 'latin1')],
    [{ filterValue: name('ASCIIHexDecode'), expected: Buffer.from([0xab, 0xc0]) }, Buffer.from(' A b C > \r\n', 'latin1')],
    [{ filterValue: name('ASCII85Decode'), expected: Buffer.alloc(4) }, Buffer.from('z~>', 'latin1')],
    [{ filterValue: name('ASCII85Decode'), expected: Buffer.alloc(8) }, Buffer.from('zz~>', 'latin1')],
    [{ filterValue: name('ASCII85Decode'), expected: Buffer.from('abcdefgh', 'latin1') }, ascii85(Buffer.from('abcdefgh', 'latin1'))],
    [{ filterValue: name('ASCII85Decode'), expected: Buffer.from([0xff, 0xff, 0xff, 0xff]) }, Buffer.from('s8W-!~>', 'latin1')],
    [{ filterValue: name('FlateDecode') }, compressed],
    [{ filterValue: name('RunLengthDecode') }, runLength(plain)],
    [{ filterValue: name('RunLengthDecode'), expected: Buffer.from('ABCZZZ', 'latin1') }, Buffer.from([2, 65, 66, 67, 254, 90, 128])],
    [{ filterValue: array([name('ASCIIHexDecode'), name('FlateDecode')]), decodeParmsValue: array([nil, nil]) }, Buffer.from(compressed.toString('hex') + '>', 'latin1')],
    [{ filterValue: array([name('ASCII85Decode'), name('FlateDecode')]), decodeParmsValue: array([dict(), dict([['Predictor', { type: 'number', integer: true, raw: '1', value: 1 }]])]) }, ascii85(compressed)],
    [{ filterValue: array([name('ASCIIHexDecode'), name('RunLengthDecode')]), decodeParmsValue: array([nil, nil]) }, Buffer.from(`${runLength(plain).toString('hex')}>`, 'latin1')],
    [{ filterValue: array([name('ASCII85Decode'), name('RunLengthDecode')]), decodeParmsValue: array([dict(), dict()]) }, ascii85(runLength(plain))],
  ];
  for (const [controls, encoded] of cases) assert.deepEqual(decodePdfControlStream({ encodedBytes: encoded, ...controls, scope: 'xref', maximumDecodedBytes: 1024, budget: budget() }).bytes, controls.expected ?? plain);
  for (const length of [0, 1, 2, 3]) {
    const value = Buffer.from([1, 2, 3].slice(0, length));
    assert.deepEqual(decodePdfControlStream({ encodedBytes: ascii85(value), filterValue: array([name('ASCII85Decode')]), decodeParmsValue: array([nil]), scope: 'object', maximumDecodedBytes: 4, budget: budget() }).bytes, value);
  }
  const incompressible = Buffer.from([1, 2, 3, 4]); const largerIntermediate = deflateSync(incompressible);
  assert.ok(largerIntermediate.length > incompressible.length);
  assert.deepEqual(decodePdfControlStream({ encodedBytes: Buffer.from(`${largerIntermediate.toString('hex')}>`, 'latin1'), filterValue: array([name('ASCIIHexDecode'), name('FlateDecode')]), scope: 'xref', maximumDecodedBytes: incompressible.length, budget: budget() }).bytes, incompressible);
});

test('RunLength decoding enforces control boundaries, exact EOD, output, and work limits', () => {
  const boundaries = Buffer.concat([
    Buffer.from([0, 65, 127]), Buffer.alloc(128, 66),
    Buffer.from([129, 67, 255, 68, 128]),
  ]);
  const expected = Buffer.concat([
    Buffer.from('A'), Buffer.alloc(128, 66), Buffer.alloc(128, 67), Buffer.alloc(2, 68),
  ]);
  assert.deepEqual(decodePdfControlStream({ encodedBytes: boundaries, filterValue: name('RunLengthDecode'), scope: 'object', maximumDecodedBytes: expected.length, budget: budget() }).bytes, expected);
  assert.deepEqual(decodePdfControlStream({ encodedBytes: Buffer.from([128]), filterValue: name('RunLengthDecode'), scope: 'xref', maximumDecodedBytes: 0, budget: budget() }).bytes, Buffer.alloc(0));
  for (const encodedBytes of [
    Buffer.alloc(0), Buffer.from([0]), Buffer.from([0, 65]),
    Buffer.from([129]), Buffer.from([128, 0]), Buffer.from([1, 65, 128]),
  ]) assert.throws(() => decodePdfControlStream({ encodedBytes, filterValue: name('RunLengthDecode'), scope: 'xref', maximumDecodedBytes: 1024, budget: budget() }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  assert.throws(() => decodePdfControlStream({ encodedBytes: Buffer.from([255, 65, 128]), filterValue: name('RunLengthDecode'), decodeParmsValue: dict([['Predictor', number(1)]]), scope: 'object', maximumDecodedBytes: 2, budget: budget() }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  const exact = budget(); exact.objectFilterWorkBytes = (16 * 1024 * 1024) - 2;
  assert.deepEqual(decodePdfControlStream({ encodedBytes: Buffer.from([255, 65, 128]), filterValue: name('RunLengthDecode'), scope: 'object', maximumDecodedBytes: 2, budget: exact }).bytes, Buffer.from('AA'));
  assert.equal(exact.objectFilterWorkBytes, 16 * 1024 * 1024);
  const short = budget(); short.objectFilterWorkBytes = (16 * 1024 * 1024) - 1;
  assert.throws(() => decodePdfControlStream({ encodedBytes: Buffer.from([255, 65, 128]), filterValue: name('RunLengthDecode'), scope: 'object', maximumDecodedBytes: 2, budget: short }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  assert.equal(short.objectFilterWorkBytes, (16 * 1024 * 1024) - 1);
});

test('Flate PNG predictors reconstruct row methods without conflating declared and actual methods', () => {
  const encoded = deflateSync(Buffer.from([0, 1, 2, 3, 1, 4, 3, 3]));
  const params = dict([['Predictor', number(15)], ['Columns', number(3)]]);
  const result = decodePdfControlStream({ encodedBytes: encoded, filterValue: name('FlateDecode'), decodeParmsValue: params, scope: 'xref', maximumDecodedBytes: 6, budget: budget(), predictorShape: { columns: 3, rows: 2 } });
  assert.deepEqual(result.bytes, Buffer.from([1, 2, 3, 4, 7, 10]));
  assert.deepEqual(result.predictor, { kind: 'png', declared: 15, columns: 3, colors: 1, bitsPerComponent: 8 });
  for (const bad of [dict([['Predictor', number(2)]]), dict([['Predictor', number(10)], ['Columns', number(65_537)]]), dict([['Predictor', number(10)], ['Columns', number(3)], ['Colors', number(2)]])]) assert.throws(() => decodePdfControlStream({ encodedBytes: encoded, filterValue: name('FlateDecode'), decodeParmsValue: bad, scope: 'xref', maximumDecodedBytes: 6, budget: budget() }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
});

test('PNG predictor methods, parameter boundaries, immutable filters, and malformed rows fail closed', () => {
  const actual = Buffer.from([250, 5, 100, 10, 50, 60, 3, 2, 1, 255, 0, 128]); const columns = 3;
  for (const method of [0, 1, 2, 3, 4]) for (const declared of [10, 15]) {
    const params = dict([['Predictor', number(declared)], ['Colors', number(1)], ['BitsPerComponent', number(8)], ['Columns', number(columns)]]);
    const result = decodePdfControlStream({ encodedBytes: deflateSync(pngRows(actual, columns, [0, method, method, method])), filterValue: name('FlateDecode'), decodeParmsValue: params, scope: 'object', maximumDecodedBytes: actual.length, budget: budget() });
    assert.deepEqual(result.bytes, actual); assert.equal(Object.isFrozen(result.filters), true); assert.equal(Object.isFrozen(result.predictor), true); assert.throws(() => { result.filters.push('x'); }, TypeError);
  }
  const paethTie = decodePdfControlStream({
    encodedBytes: deflateSync(Buffer.from([0, 2, 3, 4, 254, 5])), filterValue: name('FlateDecode'),
    decodeParmsValue: dict([['Predictor', number(15)], ['Columns', number(2)]]), scope: 'xref',
    maximumDecodedBytes: 4, budget: budget(), predictorShape: { columns: 2, rows: 2 },
  });
  assert.deepEqual(paethTie.bytes, Buffer.from([2, 3, 0, 5]));
  const defaultsAndWrap = decodePdfControlStream({
    encodedBytes: deflateSync(Buffer.from([0, 250, 2, 11])), filterValue: name('FlateDecode'),
    decodeParmsValue: dict([['Predictor', number(10)]]), scope: 'object', maximumDecodedBytes: 2, budget: budget(),
  });
  assert.deepEqual(defaultsAndWrap.bytes, Buffer.from([250, 5]));
  const encoded = deflateSync(pngRows(actual, columns, [0, 1, 2, 3]));
  const invalidParameters = [
    ...[2, 3, 4, 5, 6, 7, 8, 9, 16].map((value) => dict([['Predictor', number(value)]])),
    ...[0, 65_537].map((value) => dict([['Predictor', number(10)], ['Columns', number(value)]])),
    ...[1, 2, 4, 16].map((value) => dict([['Predictor', number(10)], ['Columns', number(columns)], ['BitsPerComponent', number(value)]])),
    dict([['Predictor', number(10)], ['Columns', number(columns)], ['Colors', number(2)]]), dict([['Predictor', number(10)], ['Columns', { type: 'ref', object: 1, generation: 0 }]]), dict([['Predictor', number(10)], ['Columns', number(columns)], ['Extra', number(1)]]),
  ];
  for (const decodeParmsValue of invalidParameters) assert.throws(() => decodePdfControlStream({ encodedBytes: encoded, filterValue: name('FlateDecode'), decodeParmsValue, scope: 'xref', maximumDecodedBytes: actual.length, budget: budget() }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  for (const bad of [Buffer.from([5, 0, 0, 0]), Buffer.from([0, 0, 0]), Buffer.concat([pngRows(actual, columns, [0, 1, 2, 3]), Buffer.from([0])])]) assert.throws(() => decodePdfControlStream({ encodedBytes: deflateSync(bad), filterValue: name('FlateDecode'), decodeParmsValue: dict([['Predictor', number(15)], ['Columns', number(columns)]]), scope: 'xref', maximumDecodedBytes: actual.length, budget: budget() }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  for (const predictorShape of [{ columns: 2, rows: 6 }, { columns, rows: 5 }]) assert.throws(() => decodePdfControlStream({ encodedBytes: deflateSync(pngRows(actual, columns, [0, 1, 2, 3])), filterValue: name('FlateDecode'), decodeParmsValue: dict([['Predictor', number(15)], ['Columns', number(columns)]]), scope: 'xref', maximumDecodedBytes: actual.length, budget: budget(), predictorShape }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  const tagged = deflateSync(pngRows(actual, columns, [0, 1, 2, 3]));
  for (const outer of ['ASCIIHexDecode', 'ASCII85Decode']) { const wrapped = outer === 'ASCIIHexDecode' ? Buffer.from(`${tagged.toString('hex')}>`, 'latin1') : ascii85(tagged); const result = decodePdfControlStream({ encodedBytes: wrapped, filterValue: array([name(outer), name('FlateDecode')]), decodeParmsValue: array([nil, dict([['Predictor', number(15)], ['Columns', number(columns)]])]), scope: 'xref', maximumDecodedBytes: actual.length, budget: budget() }); assert.deepEqual(result.bytes, actual); }
  const oneRow = deflateSync(Buffer.from([0, 1, 2, 3])); const exactWork = budget(); exactWork.xrefFilterWorkBytes = (16 * 1024 * 1024) - 7;
  assert.deepEqual(decodePdfControlStream({ encodedBytes: oneRow, filterValue: name('FlateDecode'), decodeParmsValue: dict([['Predictor', number(15)], ['Columns', number(3)]]), scope: 'xref', maximumDecodedBytes: 3, budget: exactWork, predictorShape: { columns: 3, rows: 1 } }).bytes, Buffer.from([1, 2, 3]));
  assert.equal(exactWork.xrefFilterWorkBytes, 16 * 1024 * 1024);
  const shortWork = budget(); shortWork.xrefFilterWorkBytes = (16 * 1024 * 1024) - 6;
  assert.throws(() => decodePdfControlStream({ encodedBytes: oneRow, filterValue: name('FlateDecode'), decodeParmsValue: dict([['Predictor', number(15)], ['Columns', number(3)]]), scope: 'xref', maximumDecodedBytes: 3, budget: shortWork, predictorShape: { columns: 3, rows: 1 } }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  assert.equal(shortWork.xrefFilterWorkBytes, (16 * 1024 * 1024) - 6);
  const predictorBombBudget = budget();
  assert.throws(() => decodePdfControlStream({ encodedBytes: deflateSync(Buffer.alloc(1024 * 1024)), filterValue: name('FlateDecode'), decodeParmsValue: dict([['Predictor', number(15)]]), scope: 'object', maximumDecodedBytes: 6, budget: predictorBombBudget }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  assert.equal(predictorBombBudget.objectFilterWorkBytes, 0);
});

test('control filters reject malformed codecs, unsupported pipelines and bounded work', () => {
  for (const value of ['0', '0G>', '00>x', '00>>']) assert.throws(() => decodePdfControlStream({ encodedBytes: Buffer.from(value, 'latin1'), filterValue: name('ASCIIHexDecode'), scope: 'object', maximumDecodedBytes: 10, budget: budget() }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  for (const value of ['u uuuu~>', '!~>', '<~z~>', 'y~>', '!z~>', '!!~x', 'z~>x']) assert.throws(() => decodePdfControlStream({ encodedBytes: Buffer.from(value, 'latin1'), filterValue: name('ASCII85Decode'), scope: 'object', maximumDecodedBytes: 10, budget: budget() }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  for (const filterValue of [name('LZWDecode'), array([name('FlateDecode'), name('ASCIIHexDecode')]), array([name('FlateDecode'), name('FlateDecode')])]) assert.throws(() => decodePdfControlStream({ encodedBytes: Buffer.alloc(0), filterValue, scope: 'xref', maximumDecodedBytes: 10, budget: budget() }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  assert.throws(() => decodePdfControlStream({ encodedBytes: Buffer.from('00>', 'latin1'), filterValue: name('ASCIIHexDecode'), decodeParmsValue: dict([['Predictor', { type: 'number', integer: true, value: 2 }]]), scope: 'xref', maximumDecodedBytes: 10, budget: budget() }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  for (const encodedBytes of [compressedTruncated(), compressedTrailing(), compressedConcatenated()]) assert.throws(() => decodePdfControlStream({ encodedBytes, filterValue: name('FlateDecode'), scope: 'xref', maximumDecodedBytes: 1024, budget: budget() }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  assert.throws(() => decodePdfControlStream({ encodedBytes: Buffer.from('0000>', 'latin1'), filterValue: name('ASCIIHexDecode'), scope: 'xref', maximumDecodedBytes: 10, budget: { xrefFilterWorkBytes: (16 * 1024 * 1024) - 1, objectFilterWorkBytes: 0 } }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  const bombBudget = budget(); const bomb = deflateSync(Buffer.alloc(1024 * 1024));
  assert.throws(() => decodePdfControlStream({ encodedBytes: bomb, filterValue: name('FlateDecode'), scope: 'xref', maximumDecodedBytes: 6, budget: bombBudget }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
  assert.equal(bombBudget.xrefFilterWorkBytes, 0);
  assert.throws(() => decodePdfControlStream({ encodedBytes: Buffer.alloc(0), filterValue: array([]), scope: 'xref', maximumDecodedBytes: 0, budget: budget() }), { code: 'INVALID_PDF_CONTROL_STREAM_FILTER' });
});

function compressedTruncated() { const value = deflateSync(Buffer.from('value')); return value.subarray(0, value.length - 1); }
function compressedTrailing() { return Buffer.concat([deflateSync(Buffer.from('value')), Buffer.from([0])]); }
function compressedConcatenated() { const value = deflateSync(Buffer.from('value')); return Buffer.concat([value, value]); }
