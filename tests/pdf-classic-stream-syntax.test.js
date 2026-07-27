import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePdfIndirectObject } from '../scripts/host/pdf-classic-syntax.mjs';

const reference = Object.freeze({ object: 1, generation: 0 });

function parse(body) {
  const bytes = Buffer.from(body, 'latin1');
  return { bytes, object: parsePdfIndirectObject(bytes, 0, reference) };
}

test('classic stream syntax records exact zero-length, LF, and CRLF payload spans', () => {
  for (const { body, expected } of [
    { body: '1 0 obj\n<< /Length 0 >>\nstream\nendstream\nendobj', expected: '' },
    { body: '1 0 obj\n<< /Length 3 >>\nstream\nabc\nendstream\nendobj', expected: 'abc' },
    { body: '1 0 obj\r\n<< /Length 3 >>\r\nstream\r\nabc\r\nendstream\r\nendobj', expected: 'abc' },
  ]) {
    const { bytes, object } = parse(body);
    assert.equal(object.stream, true);
    assert.equal(object.streamLength, Buffer.byteLength(expected, 'latin1'));
    assert.equal(
      bytes.subarray(object.streamStart, object.streamStart + object.streamLength).toString('latin1'),
      expected,
    );
  }
});

test('classic stream syntax rejects CR-only framing and mismatched direct lengths', () => {
  for (const body of [
    '1 0 obj\n<< /Length 3 >>\nstream\rabc\rendstream\nendobj',
    '1 0 obj\n<< /Length 2 >>\nstream\nabc\nendstream\nendobj',
    '1 0 obj\n<< /Length 4 >>\nstream\nabcendstream\nendobj',
  ]) assert.throws(() => parse(body), { code: 'INVALID_CLASSIC_PDF_SYNTAX' });
});
