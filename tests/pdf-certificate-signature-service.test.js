import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfCertificateSignatureService } from '../scripts/host/pdf-certificate-signature-service.mjs';
import { cleanupCertificateSignatureJob } from '../scripts/host/pdf-certificate-signature-job.mjs';

const CERTIFICATE = 'a'.repeat(64);
const CMS = Buffer.from([0x30, 0x04, 1, 2, 3, 0]);

function fixture(contentBytes = 0) {
  const chunks = ['%PDF-1.7\n']; const offsets = new Map();
  const bodies = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>'],
    [4, `<< /Length ${contentBytes} >>\nstream\n${'x'.repeat(contentBytes)}\nendstream`],
  ]);
  for (const [number, body] of bodies) { offsets.set(number, Buffer.byteLength(chunks.join(''), 'latin1')); chunks.push(`${number} 0 obj\n${body}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 5\n0000000000 65535 f \n${[1, 2, 3, 4].map((number) => `${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function request(source, extra = {}) {
  return { profile: 'local-pdf-signature-container-v1', sourceSha256: digest(source), page: 1, fieldName: 'Signature 1', reason: 'Test', location: 'Local', contact: '', placeholderBytes: 4096, ...extra };
}

async function setup(t, adapter) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-certificate-signature-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const sourceBytes = fixture();
  const source = await store.createDocument({ stream: (async function* () { yield sourceBytes; })(), displayName: 'source.pdf' });
  const service = new PdfCertificateSignatureService({ store, adapter });
  return { store, source, sourceBytes, service };
}

function fakeAdapter({ cms = CMS, trustStatus = 'passes', trustReason = 'none', onCall, onVerify } = {}) {
  return {
    async createDetachedCms({ workspacePath, requestPath }, options) {
      const request = JSON.parse(await readFile(requestPath, 'utf8'));
      const input = await readFile(join(workspacePath, 'input.bin'));
      onCall?.({ request, input, options, workspacePath });
      const cmsSha256 = digest(cms);
      await writeFile(join(workspacePath, 'detached.cms'), cms, { mode: 0o600 });
      return { version: 1, ok: true, result: { operation: 'createDetachedCMS', certificateSha256: request.certificateSha256, inputSha256: digest(input), cmsSha256, cmsBytes: cms.length, outputFilename: 'detached.cms' } };
    },
    async verifyDetachedCms({ workspacePath, requestPath }, options) {
      const request = JSON.parse(await readFile(requestPath, 'utf8'));
      const input = await readFile(join(workspacePath, 'input.bin'));
      const cmsBytes = await readFile(join(workspacePath, 'detached.cms'));
      onVerify?.({ request, input, cms: cmsBytes, options, workspacePath });
      return { version: 1, ok: true, result: {
        operation: 'verifyDetachedCMS', inputSha256: digest(input), cmsSha256: digest(cmsBytes), certificateSha256: request.certificateSha256,
        signatureValid: true, trustStatus, trustReason, timestampValidated: false, ltv: false, revocationOnlineChecked: false,
      } };
    },
  };
}

test('certificate signature service binds request/input/CMS, independently inspects output, promotes artifact, and cleans workspace', async (t) => {
  let observed; let observedVerify;
  const { store, source, sourceBytes, service } = await setup(t, fakeAdapter({ onCall: (value) => { observed = value; }, onVerify: (value) => { observedVerify = value; } }));
  const result = await service.sign(source.id, request(sourceBytes), { certificateSha256: CERTIFICATE, consent: true });
  assert.equal(result.artifact.documentId, source.id);
  assert.equal(result.proof.sourcePrefixPreserved, true);
  assert.equal(result.receipt.certificateSha256, CERTIFICATE);
  assert.equal(observed.request.version, 1);
  assert.equal(observed.request.operation, 'createDetachedCMS');
  assert.deepEqual(Object.keys(observed.request).sort(), ['certificateSha256', 'inputFilename', 'inputSha256', 'operation', 'version']);
  assert.equal(observed.request.certificateSha256, CERTIFICATE);
  assert.equal(observed.request.inputSha256, result.proof.bytesToSignSha256);
  assert.equal(observed.input.length, result.proof.byteRange[1] + result.proof.byteRange[3]);
  assert.deepEqual(Object.keys(observedVerify.request).sort(), ['certificateSha256', 'cmsFilename', 'cmsSha256', 'inputFilename', 'inputSha256', 'operation', 'version']);
  assert.equal(observedVerify.request.operation, 'verifyDetachedCMS');
  assert.equal(observedVerify.request.inputFilename, 'input.bin');
  assert.equal(observedVerify.request.cmsFilename, 'detached.cms');
  assert.equal(observedVerify.request.inputSha256, result.proof.bytesToSignSha256);
  assert.equal(observedVerify.request.cmsSha256, result.receipt.cmsSha256);
  assert.equal(observedVerify.input.equals(observed.input), true);
  assert.equal(observedVerify.cms.equals(CMS), true);
  assert.equal((await readFile(store.getSourcePath(source.id))).equals(sourceBytes), true);
  assert.deepEqual(await readdir(join(store.root, 'jobs')), []);
  assert.equal(result.artifact.operation.expected.trustValidated, true);
  assert.equal(result.artifact.operation.expected.timestamped, false);
  assert.equal(result.verificationReceipt.signatureValid, true);
  assert.equal(result.verificationReceipt.trustStatus, 'passes');
  assert.equal(result.artifact.operation.expected.signatureValid, true);
  assert.equal(result.artifact.operation.expected.trustStatus, 'passes');
  assert.deepEqual({ ...result.artifact.operation.expected.verificationReceipt }, result.verificationReceipt);
  assert.equal(result.artifact.operation.validation.validators.includes('offline-detached-cms-verification'), true);
});

test('certificate signature service rejects unavailable/helper errors and cancellation with stable host errors', async (t) => {
  let consentAttempted = false;
  const consentState = await setup(t, fakeAdapter({ onCall: () => { consentAttempted = true; } }));
  await assert.rejects(
    consentState.service.sign(consentState.source.id, request(consentState.sourceBytes), { certificateSha256: CERTIFICATE }),
    { code: 'CERTIFICATE_SIGN_CONSENT_REQUIRED' },
  );
  assert.equal(consentAttempted, false);

  const unavailableState = await setup(t, null);
  await assert.rejects(unavailableState.service.sign(unavailableState.source.id, request(unavailableState.sourceBytes), { certificateSha256: CERTIFICATE, consent: true }), { code: 'CERTIFICATE_SIGNATURE_ADAPTER_UNAVAILABLE' });

  const deniedAdapter = { createDetachedCms: async () => { const error = new Error('denied'); error.code = 'SIGNING_IDENTITY_PLATFORM_DENIED'; throw error; }, verifyDetachedCms: async () => { throw new Error('unreachable'); } };
  const deniedState = await setup(t, deniedAdapter);
  await assert.rejects(deniedState.service.sign(deniedState.source.id, request(deniedState.sourceBytes), { certificateSha256: CERTIFICATE, consent: true }), { code: 'CERTIFICATE_SIGNATURE_PLATFORM_DENIED' });

  const controller = new AbortController(); controller.abort();
  const cancelledState = await setup(t, fakeAdapter());
  await assert.rejects(cancelledState.service.sign(cancelledState.source.id, request(cancelledState.sourceBytes), { certificateSha256: CERTIFICATE, consent: true, signal: controller.signal }), { code: 'JOB_CANCELLED' });
});

test('certificate signature service records an untrusted but cryptographically valid detached CMS', async (t) => {
  const state = await setup(t, fakeAdapter({ trustStatus: 'fails', trustReason: 'expired' }));
  const result = await state.service.sign(state.source.id, request(state.sourceBytes), { certificateSha256: CERTIFICATE, consent: true });
  assert.equal(result.verificationReceipt.signatureValid, true);
  assert.equal(result.verificationReceipt.trustStatus, 'fails');
  assert.equal(result.artifact.operation.expected.trustValidated, false);
  assert.match(result.limitations.join(' '), /not promoted as trusted/u);
  assert.match(result.limitations.join(' '), /expired/u);
});

test('certificate signature service fails closed on verification mismatch, helper errors, tampering, and cancellation', async (t) => {
  const mismatch = await setup(t, {
    ...fakeAdapter(),
    async verifyDetachedCms() {
      return { version: 1, ok: true, result: {
        operation: 'verifyDetachedCMS', inputSha256: digest(Buffer.from('wrong')), cmsSha256: digest(CMS), certificateSha256: CERTIFICATE,
        signatureValid: false, trustStatus: 'fails', trustReason: 'not-trusted', timestampValidated: false, ltv: false, revocationOnlineChecked: false,
      } };
    },
  });
  await assert.rejects(mismatch.service.sign(mismatch.source.id, request(mismatch.sourceBytes), { certificateSha256: CERTIFICATE, consent: true }), { code: 'CERTIFICATE_SIGNATURE_VERIFICATION_FAILED' });
  assert.deepEqual(await readdir(join(mismatch.store.root, 'jobs')), []);

  const helperError = await setup(t, {
    ...fakeAdapter(),
    async verifyDetachedCms() { const error = new Error('bad CMS'); error.code = 'SIGNING_IDENTITY_CMS_INVALID'; throw error; },
  });
  await assert.rejects(helperError.service.sign(helperError.source.id, request(helperError.sourceBytes), { certificateSha256: CERTIFICATE, consent: true }), { code: 'CERTIFICATE_SIGNATURE_VERIFICATION_FAILED' });
  assert.deepEqual(await readdir(join(helperError.store.root, 'jobs')), []);

  const tampered = await setup(t, {
    ...fakeAdapter(),
    async verifyDetachedCms({ workspacePath }) {
      await writeFile(join(workspacePath, 'input.bin'), Buffer.from('tampered'), { mode: 0o600 });
      return { version: 1, ok: true, result: {
        operation: 'verifyDetachedCMS', inputSha256: digest(Buffer.from('tampered')), cmsSha256: digest(CMS), certificateSha256: CERTIFICATE,
        signatureValid: true, trustStatus: 'passes', trustReason: 'none', timestampValidated: false, ltv: false, revocationOnlineChecked: false,
      } };
    },
  });
  await assert.rejects(tampered.service.sign(tampered.source.id, request(tampered.sourceBytes), { certificateSha256: CERTIFICATE, consent: true }), { code: 'CERTIFICATE_SIGNATURE_TAMPERED' });
  assert.deepEqual(await readdir(join(tampered.store.root, 'jobs')), []);

  const controller = new AbortController();
  const cancelled = await setup(t, {
    ...fakeAdapter(),
    async verifyDetachedCms({ workspacePath }, options) {
      controller.abort();
      const input = await readFile(join(workspacePath, 'input.bin'));
      return { version: 1, ok: true, result: {
        operation: 'verifyDetachedCMS', inputSha256: digest(input), cmsSha256: digest(CMS), certificateSha256: CERTIFICATE,
        signatureValid: true, trustStatus: 'passes', trustReason: 'none', timestampValidated: false, ltv: false, revocationOnlineChecked: false,
      } };
    },
  });
  await assert.rejects(cancelled.service.sign(cancelled.source.id, request(cancelled.sourceBytes), { certificateSha256: CERTIFICATE, consent: true, signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(await readdir(join(cancelled.store.root, 'jobs')), []);
});

test('certificate signature service detects helper tampering and stale source', async (t) => {
  let call;
  const fixtureState = await setup(t, {
    async createDetachedCms({ workspacePath, requestPath }) {
      const inputPath = join(workspacePath, 'input.bin');
      const requestBytes = await readFile(requestPath);
      const input = await readFile(inputPath);
      await writeFile(inputPath, Buffer.concat([input, Buffer.from('tamper')]), { mode: 0o600 });
      call = { requestBytes };
      return { version: 1, ok: true, result: { operation: 'createDetachedCMS', certificateSha256: CERTIFICATE, inputSha256: digest(input), cmsSha256: digest(CMS), cmsBytes: CMS.length, outputFilename: 'detached.cms' } };
    },
    async verifyDetachedCms() { throw new Error('unreachable after input tamper'); },
  });
  await assert.rejects(fixtureState.service.sign(fixtureState.source.id, request(fixtureState.sourceBytes), { certificateSha256: CERTIFICATE, consent: true }), { code: 'CERTIFICATE_SIGNATURE_TAMPERED' });
  assert.ok(call);

  const stale = await setup(t, fakeAdapter());
  await writeFile(stale.store.getSourcePath(stale.source.id), Buffer.concat([stale.sourceBytes, Buffer.from('\n')]), { mode: 0o600 });
  await assert.rejects(stale.service.sign(stale.source.id, request(stale.sourceBytes), { certificateSha256: CERTIFICATE, consent: true }), { code: 'SOURCE_INTEGRITY_FAILED' });
  await chmod(stale.store.getSourcePath(stale.source.id), 0o600);
});

test('certificate signature service enforces the native helper bytes-to-sign bound', async (t) => {
  const largeBytes = fixture(16 * 1024 * 1024);
  const state = await setup(t, fakeAdapter());
  // Replace the fixture document with a separately created bounded oversized source.
  await state.store.deleteDocument(state.source.id);
  const source = await state.store.createDocument({ stream: (async function* () { yield largeBytes; })(), displayName: 'large.pdf' });
  await assert.rejects(state.service.sign(source.id, request(largeBytes), { certificateSha256: CERTIFICATE, consent: true }), { code: 'CERTIFICATE_SIGNATURE_INPUT_TOO_LARGE' });
});

test('certificate signature cleanup surfaces promoted-artifact revocation failures', async () => {
  const calls = [];
  await assert.rejects(cleanupCertificateSignatureJob({
    store: {
      async cleanupJob(workspace) { calls.push(['cleanup', workspace]); },
      async deleteArtifact(id) { calls.push(['delete', id]); throw new Error('delete failed'); },
    },
    lifecycle: { workspace: '/private/workspace-a', verificationWorkspace: '/private/workspace-b', promotedArtifact: { id: 'artifact-1' }, completed: false },
  }), { code: 'CERTIFICATE_SIGNATURE_CLEANUP_FAILED' });
  assert.deepEqual(calls, [['cleanup', '/private/workspace-a'], ['cleanup', '/private/workspace-b'], ['delete', 'artifact-1']]);
});
