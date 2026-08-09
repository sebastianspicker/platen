import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deliverProfessionalCapability } from '../scripts/host/professional-capability/index.mjs';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { assertEffectContract } from './support/professional-capability-delivery-support.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const effectContracts = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/professional-capability-effect-contracts.json'), 'utf8'),
);
const secret = 'CONFIDENTIAL-PAYLOAD';
const passwords = Object.freeze({
  userPassword: 'UserPass12!abc',
  ownerPassword: 'OwnerPass12!xyz',
});
const aesHeader = Buffer.from('%PLATEN-AES128-V1\n', 'utf8');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertSealedPackage(outcome, source) {
  assert.equal(outcome.pdf.subarray(0, aesHeader.length).equals(aesHeader), true);
  assert.equal(outcome.pdf.includes(Buffer.from(secret, 'utf8')), false);
  assert.equal(outcome.sourceSha256, sha256(source));
  assert.equal(outcome.sealedSha256, sha256(outcome.pdf));
  assert.notEqual(outcome.sealedSha256, outcome.sourceSha256);
}

test('security delivery contracts use cryptographic semantics instead of fixed artifact sizes', async () => {
  const source = createTextPdf({ text: secret, title: 'Sensitive' });
  const context = { sourcePdf: source, secret, ...passwords };
  const encryptedIds = [
    'security.certificate-encryption',
    'security.encryption-aes',
    'security.security-envelopes',
  ];

  for (const id of encryptedIds) {
    assert.equal(Object.hasOwn(effectContracts.contracts[id].equals ?? {}, 'bytes'), false);
    const outcome = await deliverProfessionalCapability(id, {
      ...context,
      ...(id === 'security.certificate-encryption' ? { recipientFingerprint: 'a'.repeat(64) } : {}),
    });
    assertEffectContract(assert, effectContracts, id, outcome);
    assertSealedPackage(outcome, source);
    if (id === 'security.certificate-encryption') {
      assert.equal(outcome.recipientFingerprint, 'a'.repeat(64));
    }
  }

  await assert.rejects(
    deliverProfessionalCapability('security.open-password', context),
    { code: 'SECURITY_OPEN_PASSWORD_UNAVAILABLE', status: 503 },
  );
  await assert.rejects(
    deliverProfessionalCapability('security.remove-protection', context),
    { code: 'SECURITY_PROTECTION_REMOVAL_UNAVAILABLE', status: 503 },
  );
  assert.equal(Object.hasOwn(effectContracts.contracts['security.remove-protection'].equals ?? {}, 'bytes'), false);
});
