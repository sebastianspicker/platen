import assert from 'node:assert/strict';
import test from 'node:test';
import { runCertificateSignCommand, runSigningIdentitiesCommand } from '../scripts/cli/commands/signing.mjs';

test('certificate-sign command forwards source/certificate metadata and publishes exclusively', async () => {
  const calls = []; const emitted = []; const copied = [];
  const application = { certificateSignature: { sign: async (...args) => { calls.push(args); return { artifact: { id: 'a', sha256: 'c'.repeat(64) }, limitations: ['bounded'] }; } }, store: { getArtifact: (id) => ({ id, filePath: '/private/artifact.pdf' }) } };
  await runCertificateSignCommand(application, { page: 2, fieldName: 'Signature', reason: '', location: '', contact: '', placeholderBytes: 4096, certificateSha256: 'b'.repeat(64), consent: true, output: '/tmp/signed.pdf' }, { id: 'doc', sha256: 'a'.repeat(64) }, { write() {} }, undefined, { cancelled() {}, copyExclusive: async (...args) => copied.push(args), emit: async (_out, value) => emitted.push(value) });
  assert.equal(calls[0][0], 'doc'); assert.equal(calls[0][1].sourceSha256, 'a'.repeat(64)); assert.equal(calls[0][1].consent, true); assert.equal(calls[0][2].certificateSha256, 'b'.repeat(64)); assert.equal(calls[0][2].consent, true); assert.deepEqual(copied, [['/private/artifact.pdf', '/tmp/signed.pdf']]); assert.equal(emitted[0].limitations[0], 'bounded');
});

test('signing-identities command emits only privacy-minimal records and propagates cancellation', async () => {
  const output = []; const application = { signingIdentityDirectory: { list: async () => [{ certificateSha256: 'a'.repeat(64), certificateBytes: 3 }] } };
  await runSigningIdentitiesCommand(application, {}, null, undefined, { cancelled() {}, outputValue: async (_command, _stdout, value) => output.push(value) });
  assert.deepEqual(output, [{ identities: [{ certificateSha256: 'a'.repeat(64), certificateBytes: 3 }] }]);
  await assert.rejects(runSigningIdentitiesCommand(application, {}, null, { aborted: true }, { cancelled: () => { throw Object.assign(new Error('cancel'), { code: 'JOB_CANCELLED' }); } }), { code: 'JOB_CANCELLED' });
});
