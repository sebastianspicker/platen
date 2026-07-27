import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { makeMultiPagePdf, makeTextPdf } from './pdf-fixture.js';
import {
  normalizePdfTextEditRequest,
  PDF_TEXT_EDIT_PROFILE,
} from '../scripts/host/pdf-text-edit-contract.mjs';
import {
  inspectPdfTextEdit,
  writePdfTextEdit,
} from '../scripts/host/pdf-text-edit-writer.mjs';

function request(overrides = {}) {
  return {
    profile: PDF_TEXT_EDIT_PROFILE,
    page: 1,
    find: 'hello world',
    replace: 'HELLO WORLD',
    ...overrides,
  };
}

test('text edit replaces one complete unescaped Tj literal in place', () => {
  const source = makeTextPdf('hello world');
  const result = writePdfTextEdit(source, request());
  assert.equal(result.bytes.subarray(0, source.length).equals(source), true);
  assert.equal(result.proof.sourcePrefixPreserved, true);
  assert.equal(result.proof.replacementCount, 1);
  assert.deepEqual(inspectPdfTextEdit(source, result.bytes, request()), result.proof);
});

test('text edit requires equal-length printable literals and exact request shape', () => {
  assert.deepEqual(normalizePdfTextEditRequest(request()), request());
  for (const value of [
    request({ replace: 'short' }), request({ find: 'hello\\ world' }),
    request({ replace: 'hello(world' }), request({ find: 'café', replace: 'cafe' }),
    request({ extra: true }),
  ]) assert.throws(() => normalizePdfTextEditRequest(value), { code: 'INVALID_PDF_TEXT_EDIT' });
});

test('text edit rejects missing and ambiguous literals and unsafe passive boundaries', () => {
  assert.throws(() => writePdfTextEdit(makeTextPdf('other text'), request()), { code: 'UNSUPPORTED_PDF_TEXT_EDIT' });
  assert.doesNotThrow(() => writePdfTextEdit(makeMultiPagePdf(['hello world', 'hello world']), request()));
  assert.throws(() => writePdfTextEdit(makeTextPdf('hello world', { tagged: true }), request()), { code: 'UNSUPPORTED_PDF_TEXT_EDIT' });
  assert.throws(() => writePdfTextEdit(makeTextPdf('hello world', { attachment: { name: 'x.txt', content: 'x' } }), request()), { code: 'UNSUPPORTED_PDF_TEXT_EDIT' });
});

test('text edit source binding rejects a stale digest before mutation', () => {
  const source = makeTextPdf('hello world');
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  assert.throws(() => writePdfTextEdit(source, request({ sourceSha256: 'a'.repeat(64) })), { code: 'INVALID_PDF_TEXT_EDIT' });
  assert.equal(sourceSha256.length, 64);
});
