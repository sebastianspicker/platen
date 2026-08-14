import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectAnySupportedPdfKitAes128Envelope,
  inspectPdfKitAes128Envelope,
  inspectUnencryptedClassicPdfEnvelope,
} from '../scripts/host/pdf-encryption-envelope.mjs';

function classicEncryptedPdf({ permissions = -3392, duplicateVersion = false, prefix = '' } = {}) {
  const chunks = [`%PDF-1.6\n${prefix}`];
  const offsets = [0];
  const addObject = (number, body) => {
    offsets[number] = Buffer.byteLength(chunks.join(''), 'latin1');
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  };
  addObject(1, '<< /Type /Catalog >>');
  addObject(2, `<< /Filter /Standard /V 4 ${duplicateVersion ? '/V 4 ' : ''}/R 4 /Length 128 /P ${permissions} /O <${'01'.repeat(32)}> /U <${'02'.repeat(32)}> /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /EncryptMetadata true >>`);
  const xrefOffset = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push('xref\n0 3\n');
  chunks.push('0000000000 65535 f \n');
  chunks.push(`${String(offsets[1]).padStart(10, '0')} 00000 n \n`);
  chunks.push(`${String(offsets[2]).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size 3 /Root 1 0 R /Encrypt 2 0 R /ID [<${'03'.repeat(16)}> <${'03'.repeat(16)}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function classicUnencryptedPdf() {
  const object = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const offset = Buffer.byteLength('%PDF-1.6\n', 'latin1');
  const xrefOffset = offset + Buffer.byteLength(object, 'latin1');
  return Buffer.from(`%PDF-1.6\n${object}xref\n0 2\n0000000000 65535 f \n${String(offset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
}

test('fixed validator follows the final classic xref to the exact AESV2 encryption object', () => {
  const result = inspectPdfKitAes128Envelope(classicEncryptedPdf(), { expectedPermissions: -3392 });
  assert.deepEqual(result, {
    handler: 'Standard', version: 4, revision: 4, keyLengthBits: 128,
    cipher: 'AESV2', cryptFilter: 'StdCF', streamFilter: 'StdCF', stringFilter: 'StdCF',
    encryptMetadata: true, permissionsRaw: -3392,
  });
  assert.equal(Object.isFrozen(result), true);
});

test('fixed validator accepts each measured closed PDFKit permission value', () => {
  for (const permissions of [-3904, -3392, -3376, -1852]) {
    const result = inspectPdfKitAes128Envelope(
      classicEncryptedPdf({ permissions }), { expectedPermissions: permissions },
    );
    assert.equal(result.permissionsRaw, permissions);
    assert.equal(inspectAnySupportedPdfKitAes128Envelope(
      classicEncryptedPdf({ permissions }),
    ).permissionsRaw, permissions);
  }
  assert.throws(
    () => inspectAnySupportedPdfKitAes128Envelope(classicEncryptedPdf({ permissions: -1 })),
    { code: 'INVALID_ENCRYPTION_ENVELOPE' },
  );
});

test('fixed validator proves the final classic trailer has no encryption reference', () => {
  assert.deepEqual(inspectUnencryptedClassicPdfEnvelope(classicUnencryptedPdf()), {
    encrypted: false, format: 'classic-xref',
  });
  assert.throws(
    () => inspectUnencryptedClassicPdfEnvelope(classicEncryptedPdf()),
    { code: 'INVALID_ENCRYPTION_ENVELOPE' },
  );
});

test('fixed validator ignores decoy encryption text outside the xref-selected object', () => {
  const decoy = `3 0 obj\n<< /Filter /Standard /V 5 /R 6 /Length 256 /P 0 >>\nendobj\n`;
  const result = inspectPdfKitAes128Envelope(classicEncryptedPdf({ prefix: decoy }), { expectedPermissions: -3392 });
  assert.equal(result.cipher, 'AESV2');
  assert.equal(result.permissionsRaw, -3392);
});

test('fixed validator rejects wrong permissions, duplicate keys, and non-classic xref output', () => {
  assert.throws(
    () => inspectPdfKitAes128Envelope(classicEncryptedPdf({ permissions: -3904 }), { expectedPermissions: -3392 }),
    { code: 'INVALID_ENCRYPTION_ENVELOPE' },
  );
  assert.throws(
    () => inspectPdfKitAes128Envelope(classicEncryptedPdf({ duplicateVersion: true }), { expectedPermissions: -3392 }),
    { code: 'INVALID_ENCRYPTION_ENVELOPE' },
  );
  const xrefStream = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /XRef >>\nstream\nx\nendstream\nendobj\nstartxref\n9\n%%EOF\n');
  assert.throws(
    () => inspectPdfKitAes128Envelope(xrefStream, { expectedPermissions: -3904 }),
    { code: 'INVALID_ENCRYPTION_ENVELOPE' },
  );
});
