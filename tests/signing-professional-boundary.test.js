import assert from 'node:assert/strict';
import test from 'node:test';
import { handlers } from '../scripts/host/professional-capability/signatures.mjs';
import { digest, signatureFixture } from '../scripts/host/professional-capability/fixtures.mjs';
import {
  embedDetachedCms,
  inspectPdfSignatureContainer,
  preparePdfSignatureContainer,
} from '../scripts/host/pdf-signature-container-writer.mjs';

const sourcePdf = signatureFixture();

async function rejects(id, context, code) {
  await assert.rejects(() => handlers[id](context), { code });
}

test('certificate signing fails closed without an injected production identity service', async () => {
  await rejects('sign.certificate', { sourcePdf }, 'CERTIFICATE_SIGN_CONSENT_REQUIRED');
  await rejects('sign.certificate', { sourcePdf, consent: true }, 'CERTIFICATE_SIGNATURE_UNAVAILABLE');
  await rejects('sign.certificate', {}, 'SIGNATURE_SOURCE_REQUIRED');
});

test('certificate signing rejects source drift and malformed authority provenance before returning an artifact', async () => {
  await rejects('sign.certificate', {
    sourcePdf,
    consent: true,
    sourceSha256: '0'.repeat(64),
    documentId: 'doc-1',
    certificateSha256: 'a'.repeat(64),
    certificateSignature: { sign: async () => { throw new Error('must not be called'); } },
    readArtifact: async () => Buffer.from('unused'),
  }, 'SOURCE_VERSION_MISMATCH');

  await rejects('sign.certificate', {
    sourcePdf,
    consent: true,
    documentId: 'doc-1',
    certificateSha256: 'a'.repeat(64),
    page: 1,
    fieldName: 'Signature1',
    reason: 'Test',
    location: 'Local',
    contact: '',
    placeholderBytes: 4096,
    certificateSignature: { sign: async () => ({}) },
    readArtifact: async () => Buffer.from('not-a-pdf'),
  }, 'CERTIFICATE_SIGNATURE_RECEIPT_INVALID');
});

test('dedicated signing workflows are not exposed through generic professional handlers', () => {
  assert.equal(handlers['sign.electronic'], undefined);
  assert.equal(handlers['sign.validate-certificate'], undefined);
});

test('certificate signing accepts only the existing production receipt shape and rereads the exact artifact', async () => {
  const sourceSha256 = digest(sourcePdf);
  const certificateSha256 = 'a'.repeat(64);
  const request = {
    profile: 'local-pdf-signature-container-v1', sourceSha256, page: 1, fieldName: 'Signature1',
    reason: 'Professional local seal', location: 'Local', contact: '', placeholderBytes: 4096,
  };
  const prepared = preparePdfSignatureContainer(sourcePdf, request);
  const cms = Buffer.from([0x30, 0x04, 0x04, 0x02, 0x01, 0x02]);
  const signedPdf = embedDetachedCms(prepared, cms).bytes;
  const proof = inspectPdfSignatureContainer(sourcePdf, signedPdf, request, digest(cms));
  const receipt = {
    artifact: { id: 'signed-1', documentId: 'doc-1', mediaType: 'application/pdf', size: signedPdf.length, sha256: digest(signedPdf) },
    proof,
    receipt: {
      operation: 'createDetachedCMS', certificateSha256, inputSha256: proof.bytesToSignSha256,
      cmsSha256: digest(cms), cmsBytes: cms.length, outputFilename: 'detached.cms',
    },
    verificationReceipt: {
      operation: 'verifyDetachedCMS', inputSha256: proof.bytesToSignSha256, cmsSha256: digest(cms),
      certificateSha256, signatureValid: true, trustStatus: 'fails', trustReason: 'not-trusted',
      timestampValidated: false, ltv: false, revocationOnlineChecked: false,
    },
  };
  const outcome = await handlers['sign.certificate']({
    sourcePdf, sourceSha256, documentId: 'doc-1', certificateSha256, consent: true, ...request,
    certificateSignature: { sign: async () => receipt },
    readArtifact: async (artifact) => {
      assert.equal(artifact.sha256, digest(signedPdf));
      return Buffer.from(signedPdf);
    },
  });
  assert.equal(outcome.certificateSignature, true);
  assert.equal(outcome.pdf.equals(signedPdf), true);
  assert.equal(outcome.outputSha256, digest(signedPdf));
});

test('trust, timestamp, revocation, certification, identity, and workflow claims fail closed', async () => {
  const expected = {
    'sign.timestamp': 'TIMESTAMP_AUTHORITY_UNAVAILABLE',
    'sign.certify-document': 'CERTIFICATION_AUTHORITY_UNAVAILABLE',
    'sign.trust-store': 'TRUST_STORE_UNAVAILABLE',
    'sign.revocation-ltv': 'REVOCATION_AUTHORITY_UNAVAILABLE',
    'sign.identity-verification': 'IDENTITY_VERIFICATION_UNAVAILABLE',
    'sign.digital-id-management': 'SIGNING_IDENTITY_DIRECTORY_UNAVAILABLE',
    'sign.routed-workflow': 'ROUTED_SIGNATURE_UNAVAILABLE',
    'sign.batch-sign-seal': 'BATCH_SIGNATURE_UNAVAILABLE',
    'sign.visible-appearance': 'VISIBLE_SIGNATURE_UNAVAILABLE',
    'sign.audit-trail': 'SIGNATURE_AUDIT_UNAVAILABLE',
  };
  for (const [id, code] of Object.entries(expected)) await rejects(id, { sourcePdf }, code);
  await rejects('sign.trust-store', {
    sourcePdf,
    certificates: [{ subject: 'CN=Placeholder', sha256: 'a'.repeat(64) }],
  }, 'TRUST_STORE_UNAVAILABLE');
  await rejects('sign.timestamp', {
    sourcePdf,
    timestamp: '1970-01-01T00:00:00.000Z',
    tokenSha256: 'b'.repeat(64),
  }, 'TIMESTAMP_AUTHORITY_UNAVAILABLE');
  await rejects('sign.revocation-ltv', {
    sourcePdf,
    ocspResponse: Buffer.from('OCSP-PLACEHOLDER'),
    crl: Buffer.from('CRL-PLACEHOLDER'),
  }, 'REVOCATION_AUTHORITY_UNAVAILABLE');
});
