import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverProfessionalCapability } from '../scripts/host/professional-capability/index.mjs';

const sourceSha256 = 'a'.repeat(64);
const artifactSha256 = 'b'.repeat(64);
const outputSha256 = 'c'.repeat(64);
const artifactId = '11111111-1111-4111-8111-111111111111';
const passwords = Object.freeze({ userPassword: 'User-Pass-4567', ownerPassword: 'Owner-Pass-123' });
const signal = new AbortController().signal;

function receipt(kind, sourceDigest = sourceSha256, outputDigest = artifactSha256) {
  return {
    kind,
    sourceDigest,
    artifact: { id: artifactId, sha256: outputDigest, mediaType: 'application/pdf' },
    evidence: { artifactDigestBound: true },
  };
}

test('security capabilities fail closed without retained production authorities or sources', async () => {
  const cases = [
    ['security.open-password', { ...passwords }, 'SECURITY_OPEN_PASSWORD_UNAVAILABLE'],
    ['security.permission-controls', { profile: 'deny-all', ...passwords }, 'SECURITY_PERMISSION_CONTROLS_UNAVAILABLE'],
    ['security.remove-protection', { artifactId, artifactSha256, ownerPassword: passwords.ownerPassword }, 'SECURITY_PROTECTION_REMOVAL_UNAVAILABLE'],
    ['security.javascript-controls', { profile: 'local-document-javascript-removal-v1' }, 'SECURITY_JAVASCRIPT_CONTROLS_UNAVAILABLE'],
  ];
  for (const [id, context, code] of cases) {
    await assert.rejects(deliverProfessionalCapability(id, context), (error) => error.code === code && error.status === 503);
  }
});

test('security open-password delegates exact source, credentials, signal, and retained receipt', async () => {
  const calls = [];
  const pdfkitProtection = { protect: async (...args) => { calls.push(args); return receipt('pdfkit-password-protection'); } };
  const outcome = await deliverProfessionalCapability('security.open-password', {
    pdfkitProtection, documentId: 'doc-1', sourceSha256, permissionsProfile: 'deny-all', ...passwords, signal,
  });
  assert.equal(outcome.serviceReceipt.kind, 'pdfkit-password-protection');
  assert.equal(outcome.artifact.sha256, artifactSha256);
  assert.deepEqual(calls[0], ['doc-1', { permissionsProfile: 'deny-all', ...passwords }, { sourceSha256, signal }]);
  assert.doesNotMatch(JSON.stringify(outcome), /User-Pass-4567|Owner-Pass-123/);
});

test('permission controls are no longer advisory and require the typed protection authority', async () => {
  const calls = [];
  const pdfkitProtection = { protect: async (...args) => { calls.push(args); return receipt('pdfkit-password-protection'); } };
  const outcome = await deliverProfessionalCapability('security.permission-controls', {
    pdfkitProtection, documentId: 'doc-1', sourceSha256, profile: 'print-only', ...passwords,
  });
  assert.equal(outcome.serviceReceipt.kind, 'pdfkit-password-protection');
  assert.equal(calls[0][1].permissionsProfile, 'print-only');
  await assert.rejects(deliverProfessionalCapability('security.permission-controls', {
    pdfkitProtection, documentId: 'doc-1', sourceSha256, profile: 'print-only', ownerPassword: passwords.ownerPassword,
  }), (error) => error.code === 'INVALID_SECURITY_CREDENTIAL' && error.status === 400);
});

test('remove-protection binds retained artifact provenance and never accepts ciphertext bytes', async () => {
  const calls = [];
  const pdfkitProtection = { removeProtection: async (...args) => { calls.push(args); return receipt('pdfkit-protection-removal', artifactSha256, outputSha256); } };
  const outcome = await deliverProfessionalCapability('security.remove-protection', {
    pdfkitProtection, documentId: 'doc-1', sourceSha256, artifactId, artifactSha256, ownerPassword: passwords.ownerPassword,
  });
  assert.equal(outcome.serviceReceipt.kind, 'pdfkit-protection-removal');
  assert.deepEqual(calls[0], ['doc-1', { artifactId, artifactSha256, ownerPassword: passwords.ownerPassword }, { sourceSha256, signal: undefined }]);
  await assert.rejects(deliverProfessionalCapability('security.remove-protection', {
    pdfkitProtection, documentId: 'doc-1', sourceSha256, artifactId, sealedPdf: Buffer.from('ciphertext'), ownerPassword: passwords.ownerPassword,
  }), (error) => error.code === 'SECURITY_ARTIFACT_DIGEST_REQUIRED' && error.status === 400);
  await assert.rejects(deliverProfessionalCapability('security.remove-protection', {
    pdfkitProtection, documentId: 'doc-1', sourceSha256, artifactId, artifactSha256: 'c'.repeat(64), ownerPassword: passwords.ownerPassword,
  }), (error) => error.code === 'SECURITY_RECEIPT_INVALID' && error.status === 502);
});

test('javascript controls delegate unsupported sources as stable rejection, never ok:true failedClosed', async () => {
  const javascriptRemoval = { remove: async () => { const error = new Error('unsupported'); error.code = 'PDF_JAVASCRIPT_REMOVAL_SOURCE_UNSUPPORTED'; error.status = 422; throw error; } };
  await assert.rejects(deliverProfessionalCapability('security.javascript-controls', {
    javascriptRemoval, documentId: 'doc-1', sourceSha256, profile: 'local-document-javascript-removal-v1', signal,
  }), (error) => error.code === 'PDF_JAVASCRIPT_REMOVAL_SOURCE_UNSUPPORTED' && error.status === 422);
  await assert.rejects(deliverProfessionalCapability('security.javascript-controls', {
    javascriptRemoval, documentId: 'doc-1', sourceSha256,
  }), (error) => error.code === 'INVALID_JAVASCRIPT_CONTROLS_OPTIONS' && error.status === 400);
});

test('security authority cancellation propagates without synthesizing a result', async () => {
  const controller = new AbortController(); controller.abort();
  const pdfkitProtection = { protect: async (_id, _request, options) => { assert.equal(options.signal, controller.signal); const error = new Error('cancelled'); error.code = 'JOB_CANCELLED'; error.status = 499; throw error; } };
  await assert.rejects(deliverProfessionalCapability('security.open-password', {
    pdfkitProtection, documentId: 'doc-1', sourceSha256, permissionsProfile: 'deny-all', ...passwords, signal: controller.signal,
  }), (error) => error.code === 'JOB_CANCELLED' && error.status === 499);
});
