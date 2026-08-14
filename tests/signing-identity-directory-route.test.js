import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SigningIdentityDirectoryService } from '../scripts/host/signing-identity-directory-service.mjs';
import { handleCertificateSignRoute, handleSigningIdentityListRoute } from '../scripts/host/routes/signing-identity-routes.mjs';

function routeContext() {
  const response = new EventEmitter();
  return { pathname: '/api/signing-identities', request: { method: 'GET' }, response, url: new URL('http://local/api/signing-identities'), signingIdentityReady: true, signingIdentityDirectory: { list: async () => [{ certificateSha256: 'a'.repeat(64), certificateBytes: 3 }] }, processing: { signal: new AbortController().signal }, method: (request, expected) => assert.equal(request.method, expected), json: (_r, status, value) => { response.status = status; response.value = value; } };
}
test('identity directory uses exact private helper protocol and exposes only digest and byte count', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'identity-directory-')); context.after(() => rm(root, { recursive: true, force: true }));
  let requestBytes;
  const service = new SigningIdentityDirectoryService({ root, adapter: { listIdentities: async ({ workspacePath, requestPath }) => { requestBytes = await (await import('node:fs/promises')).readFile(requestPath); return { result: { identities: [{ certificateSha256: 'b'.repeat(64), certificateBytes: 2 }, { certificateSha256: 'a'.repeat(64), certificateBytes: 1 }, { certificateSha256: 'a'.repeat(64), certificateBytes: 1 }] } }; } } });
  assert.deepEqual(await service.list(), [{ certificateSha256: 'a'.repeat(64), certificateBytes: 1 }, { certificateSha256: 'b'.repeat(64), certificateBytes: 2 }]);
  assert.deepEqual(JSON.parse(requestBytes), { version: 1, operation: 'listSigningIdentities' });
});
test('identity list route is authenticated-service gated and privacy-minimal', async () => { const value = routeContext(); assert.equal(await handleSigningIdentityListRoute(value), true); assert.equal(value.response.status, 200); assert.deepEqual(value.response.value, { identities: [{ certificateSha256: 'a'.repeat(64), certificateBytes: 3 }] }); });
test('certificate sign route rejects unavailable staged identity before reading body', async () => { const value = { request: { method: 'POST' }, response: {}, url: new URL('http://local/api/documents/doc/certificate-sign'), documentId: 'doc', operation: 'certificate-sign', processing: { signal: new AbortController().signal }, certificateSignature: null, signingIdentityReady: false, method: (request, expected) => assert.equal(request.method, expected) }; await assert.rejects(handleCertificateSignRoute(value), { code: 'CERTIFICATE_SIGNATURE_UNAVAILABLE' }); });

function certificateContext({ aborted = false } = {}) {
  const response = new EventEmitter(); const controller = new AbortController(); if (aborted) controller.abort(); const calls = []; const deleted = [];
  const body = { profile: 'local-pdf-signature-container-v1', sourceSha256: 'a'.repeat(64), certificateSha256: 'b'.repeat(64), page: 1, fieldName: 'Signature', reason: '', location: '', contact: '', placeholderBytes: 4096, consent: true };
  return { request: { method: 'POST' }, response, url: new URL('http://local/api/documents/doc/certificate-sign'), documentId: 'doc', operation: 'certificate-sign', processing: { signal: controller.signal }, store: { deleteArtifact: async (id) => deleted.push(id) }, signingIdentityReady: true, certificateSignature: { sign: async (...args) => { calls.push(args); return { artifact: { id: 'signed-artifact' }, limitations: ['no trust claim'] }; } }, bodyLimit: 4096, exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)), method: (request, expected) => assert.equal(request.method, expected), readJson: async () => body, json: (_r, status, value) => { response.status = status; response.value = value; }, calls, deleted };
}

test('certificate sign route forwards source/certificate/request and revokes on cancellation', async () => {
  const value = certificateContext(); assert.equal(await handleCertificateSignRoute(value), true); assert.equal(value.response.status, 201); assert.equal(value.calls[0][0], 'doc'); assert.equal(value.calls[0][1].certificateSha256, undefined); assert.equal(value.calls[0][2].certificateSha256, 'b'.repeat(64)); assert.equal(value.calls[0][2].consent, true); assert.equal(value.calls[0][1].sourceSha256, 'a'.repeat(64));
  const cancelled = certificateContext({ aborted: true }); assert.equal(await handleCertificateSignRoute(cancelled), true); assert.deepEqual(cancelled.deleted, ['signed-artifact']);
});
