import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { parsePdfObjectStream } from '../scripts/host/pdf-object-stream.mjs';

const number = (value) => Object.freeze({ type: 'number', value, integer: true, raw: String(value) });
const name = (value) => Object.freeze({ type: 'name', value });

function stream(payload, entries = []) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'latin1');
  return Object.freeze({ stream: true, buffer: bytes, streamStart: 0, streamLength: bytes.length,
    value: Object.freeze({ type: 'dict', entries: new Map([
      ['Type', name('ObjStm')], ['N', number(1)], ['First', number(4)], ['Length', number(bytes.length)], ...entries,
    ]) }) });
}

test('object-stream helper requires exact unique member directory and exact member slices', () => {
  const budget = () => ({ items: 0, decodedBytes: 0, objectStreamVersions: 0, objectStreamEncodedBytes: 0, objectStreamDecodedBytes: 0 });
  assert.equal(parsePdfObjectStream(stream('2 0 << /A 1 >>'), budget())[0].object, 2);
  for (const payload of ['2 1 << /A 1 >>', '2 0 2 1 << /A 1 >>', '2 0 << /A 1 >> x']) {
    assert.throws(() => parsePdfObjectStream(stream(payload), budget()), { code: 'INVALID_PDF_OBJECT_STREAM' });
  }
});

test('object-stream helper rejects unsupported controls and fixed caps', () => {
  const budget = () => ({ items: 0, decodedBytes: 0, objectStreamVersions: 0, objectStreamEncodedBytes: 0, objectStreamDecodedBytes: 0 });
  for (const entries of [[['Filter', name('LZWDecode')]], [['DecodeParms', Object.freeze({ type: 'dict', entries: new Map() })]], [['Extra', number(1)]]]) {
    assert.throws(() => parsePdfObjectStream(stream('2 0 << /A 1 >>', entries), budget()), { code: 'INVALID_PDF_OBJECT_STREAM' });
  }
  const oversized = stream(`2 0 ${' '.repeat((2 * 1024 * 1024) + 1)}`);
  assert.throws(() => parsePdfObjectStream(oversized, budget()), { code: 'INVALID_PDF_OBJECT_STREAM' });
});

test('object-stream helper accepts one exact bounded bare-reference member', () => {
  const budget = () => ({ items: 0, decodedBytes: 0, objectStreamVersions: 0, objectStreamEncodedBytes: 0, objectStreamDecodedBytes: 0 });
  const member = parsePdfObjectStream(stream('2 0 1 0 R'), budget())[0];
  assert.deepEqual(member.value, { type: 'ref', object: 1, generation: 0 });
  assert.equal(member.decodedStart, 4);
  assert.equal(member.decodedEnd, 9);
  for (const payload of ['2 0 1 0 R x', '2 0 1 0']) {
    assert.throws(() => parsePdfObjectStream(stream(payload), budget()), { code: 'INVALID_PDF_OBJECT_STREAM' });
  }
});

test('object-stream helper rejects indirect, contradictory, and out-of-range controls', () => {
  const budget = () => ({ items: 0, decodedBytes: 0, objectStreamVersions: 0, objectStreamEncodedBytes: 0, objectStreamDecodedBytes: 0 });
  const reference = Object.freeze({ type: 'ref', object: 9, generation: 0 });
  const arrayFilter = Object.freeze({ type: 'array', values: Object.freeze([name('FlateDecode')]) });
  for (const entries of [
    [['N', number(0)]], [['N', number(10_001)]], [['N', reference]],
    [['First', number(0)]], [['First', number(100)]], [['First', reference]],
    [['Length', number(1)]], [['Length', reference]], [['Filter', arrayFilter]],
  ]) assert.throws(() => parsePdfObjectStream(stream('2 0 << /A 1 >>', entries), budget()), { code: 'INVALID_PDF_OBJECT_STREAM' });
});

test('object-stream helper rejects malformed directories and non-exhaustive member slices', () => {
  const budget = () => ({ items: 0, decodedBytes: 0, objectStreamVersions: 0, objectStreamEncodedBytes: 0, objectStreamDecodedBytes: 0 });
  const cases = [
    stream('2 1 << /A 1 >>'),
    stream('2 0 2 0 << /A 1 >>', [['N', number(2)], ['First', number(8)]]),
    stream('2 0 3 0 << /A 1 >>', [['N', number(2)], ['First', number(8)]]),
    stream('2 0 << /A 1 >> << /B 2 >>'),
    stream('2 0 stream'),
  ];
  for (const candidate of cases) assert.throws(() => parsePdfObjectStream(candidate, budget()), { code: 'INVALID_PDF_OBJECT_STREAM' });
});

test('object-stream Flate decoding consumes one complete stream and obeys aggregate budgets', () => {
  const raw = Buffer.from('2 0 << /A 1 >>', 'latin1');
  const compressed = deflateSync(raw);
  const filtered = stream(compressed, [['Filter', name('FlateDecode')], ['Length', number(compressed.length)]]);
  const budget = () => ({ items: 0, decodedBytes: 0, objectStreamVersions: 0, objectStreamEncodedBytes: 0, objectStreamDecodedBytes: 0 });
  assert.equal(parsePdfObjectStream(filtered, budget())[0].filter, 'FlateDecode');
  for (const payload of [compressed.subarray(0, compressed.length - 1), Buffer.concat([compressed, Buffer.from([0])])]) {
    const candidate = stream(payload, [['Filter', name('FlateDecode')], ['Length', number(payload.length)]]);
    assert.throws(() => parsePdfObjectStream(candidate, budget()), { code: 'INVALID_PDF_OBJECT_STREAM' });
  }
  for (const constrained of [
    { ...budget(), objectStreamVersions: 256 },
    { ...budget(), objectStreamEncodedBytes: (8 * 1024 * 1024) - compressed.length + 1 },
    { ...budget(), objectStreamDecodedBytes: (8 * 1024 * 1024) - raw.length + 1 },
    { ...budget(), items: 100_000 },
  ]) assert.throws(() => parsePdfObjectStream(filtered, constrained), { code: 'INVALID_PDF_OBJECT_STREAM' });
  const bomb = deflateSync(Buffer.concat([Buffer.from('2 0 ', 'latin1'), Buffer.alloc(8 * 1024 * 1024, 0x20), Buffer.from('null', 'latin1')]));
  assert.throws(() => parsePdfObjectStream(stream(bomb, [['Filter', name('FlateDecode')], ['Length', number(bomb.length)]]), budget()), { code: 'INVALID_PDF_OBJECT_STREAM' });
});
