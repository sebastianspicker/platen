import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  decodedPdfStringLength,
  inspectSignatureContentBounds,
} from '../scripts/host/signature-contents-boundary.mjs';

function fixture(contents) {
  const chunks = [Buffer.from('%PDF-1.7\n')];
  const spans = [];
  let offset = chunks[0].length;
  for (const token of contents) {
    chunks.push(Buffer.from('    '), token);
    offset += 4;
    spans.push({ start: offset, end: offset + token.length });
    offset += token.length;
  }
  chunks.push(Buffer.from(' trailer'));
  const bytes = Buffer.concat(chunks);
  return {
    bytes,
    signatures: spans.map(({ start, end }) => ({
      byteRange: [0, start, end, bytes.length - end],
      signatureType: 'adbe.pkcs7.detached',
    })),
  };
}

async function privateFile(t, bytes) {
  const root = await mkdtemp(join(tmpdir(), 'signature-contents-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const input = join(root, 'input.pdf');
  await writeFile(input, bytes, { mode: 0o600 });
  return { root, input };
}

test('PDF signature content framing counts bounded hex and literal strings without decoding private bytes', () => {
  assert.equal(decodedPdfStringLength(Buffer.from('<30 80 00 00>', 'ascii')), 4);
  assert.equal(decodedPdfStringLength(Buffer.from('(abc)', 'ascii')), 3);
  assert.equal(decodedPdfStringLength(Buffer.from('(a\\053\\\n(b\\)c))', 'ascii')), 7);
  for (const invalid of ['<< /Length 1 >>', '<0g>', '(unterminated', '<30>tail']) {
    assert.throws(() => decodedPdfStringLength(Buffer.from(invalid, 'ascii')), {
      code: 'SIGNATURE_DUMP_INVALID',
    });
  }
});

test('signature content admission binds exact non-overlapping ByteRange gaps and aggregate decoded bounds', async (t) => {
  const framed = fixture([Buffer.from('<30800000>', 'ascii'), Buffer.from('(abcde)', 'ascii')]);
  const { input } = await privateFile(t, framed.bytes);
  const sizes = await inspectSignatureContentBounds({
    input,
    signatures: framed.signatures,
    maxBytesPerSignature: 8,
    maxBytesTotal: 12,
  });
  assert.deepEqual(sizes, [4, 5]);
  assert.equal(Object.isFrozen(sizes), true);

  await assert.rejects(inspectSignatureContentBounds({
    input,
    signatures: framed.signatures,
    maxBytesPerSignature: 4,
    maxBytesTotal: 8,
  }), { code: 'SIGNATURE_DUMP_INVALID' });
  await assert.rejects(inspectSignatureContentBounds({
    input,
    signatures: [framed.signatures[0], {
      ...framed.signatures[1],
      byteRange: [0, framed.signatures[0].byteRange[1] + 1, framed.signatures[1].byteRange[2], framed.signatures[1].byteRange[3]],
    }],
    maxBytesPerSignature: 8,
    maxBytesTotal: 16,
  }), { code: 'SIGNATURE_DUMP_INVALID' });
});

test('signature content admission rejects linked inputs before reading an excluded gap', async (t) => {
  const framed = fixture([Buffer.from('<30800000>', 'ascii')]);
  const { root, input } = await privateFile(t, framed.bytes);
  const hardlink = join(root, 'hardlink.pdf');
  await link(input, hardlink);
  await assert.rejects(inspectSignatureContentBounds({
    input,
    signatures: framed.signatures,
    maxBytesPerSignature: 8,
    maxBytesTotal: 8,
  }), { code: 'SIGNATURE_DUMP_INVALID' });
  await rm(hardlink);
  const symlinkPath = join(root, 'symlink.pdf');
  await symlink(input, symlinkPath);
  await assert.rejects(inspectSignatureContentBounds({
    input: symlinkPath,
    signatures: framed.signatures,
    maxBytesPerSignature: 8,
    maxBytesTotal: 8,
  }), { code: 'SIGNATURE_DUMP_INVALID' });
});
