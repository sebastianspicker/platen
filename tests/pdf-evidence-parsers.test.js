import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNamedDestinations, parsePdfInfo, parseSignatures } from '../scripts/host/pdf-evidence-parsers.mjs';

test('parser compatibility facade retains bounded metadata, navigation, and signature fail-closed behavior', () => {
  assert.equal(parsePdfInfo('Pages: 1\nEncrypted: no\n').pageCount, 1);
  assert.throws(() => parsePdfInfo('Pages: 0\n'), { code: 'INVALID_ENGINE_OUTPUT', status: 502 });
  assert.throws(() => parseNamedDestinations('Page  Destination                 Name\n1 /Fit "ok"\u0000', { pageCount: 1 }), { code: 'INVALID_ENGINE_OUTPUT', status: 502 });
  assert.equal(parseSignatures("File 'private.pdf' does not contain any signatures").status, 'unsigned');
  assert.throws(() => parseSignatures('Digital Signature Info of: private.pdf\nSignature #2:'), { code: 'SIGNATURE_OUTPUT_UNRECOGNIZED', status: 502 });
});
