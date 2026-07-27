import assert from 'node:assert/strict'; import { EventEmitter } from 'node:events'; import test from 'node:test'; import { handleTaggedRemediationRoute } from '../scripts/host/routes/tagged-remediation-routes.mjs';
const request = { profile: 'local-tagged-pdf-remediation-v1', sourceSha256: 'a'.repeat(64), plan: { id: 'document', role: 'Document', children: [{ id: 'p', role: 'P', page: 1, contentIndex: 0 }] }, language: null, title: null, roleMap: {} };
function context({ aborted = false, ready = true } = {}) {
  const response = new EventEmitter(); const controller = new AbortController();
  if (aborted) controller.abort(); const calls = []; const deleted = [];
  return {
    request: { method: 'POST' }, response,
    url: new URL('http://local/api/documents/doc/tagged-remediation'),
    documentId: 'doc', operation: 'tagged-remediation',
    processing: { signal: controller.signal },
    store: { deleteArtifact: async (id) => deleted.push(id) },
    taggedRemediationReady: ready,
    taggedRemediation: ready ? {
      update: async (...args) => {
        calls.push(args); return {
          kind: 'tagged-pdf-remediation', artifact: { id: 'artifact' },
          limitations: ['not PDF/UA'],
        };
      },
    } : null,
    bodyLimit: 131072,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object'
      && !Array.isArray(value) && Object.keys(value).length === keys.length
      && Object.keys(value).every((key) => keys.includes(key)),
    method: (value, expected) => assert.equal(value.method, expected),
    readJson: async () => request,
    json: (_r, status, value) => { response.status = status; response.value = value; },
    calls, deleted,
  };
}
test('tagged route forwards canonical plan and revokes on cancellation', async () => { const value = context(); assert.equal(await handleTaggedRemediationRoute(value), true); assert.equal(value.response.status, 201); assert.equal(value.calls[0][0], 'doc'); assert.equal(value.calls[0][1].profile, request.profile); assert.deepEqual(value.calls[0][1].plan, request.plan); const cancelled = context({ aborted: true }); assert.equal(await handleTaggedRemediationRoute(cancelled), true); assert.deepEqual(cancelled.deleted, ['artifact']); });
test('tagged route rejects unavailable or malformed plan', async () => { await assert.rejects(handleTaggedRemediationRoute(context({ ready: false })), { code: 'TAGGED_PDF_REMEDIATION_UNAVAILABLE' }); await assert.rejects(handleTaggedRemediationRoute({ ...context(), readJson: async () => ({ ...request, plan: null }) }), { code: 'INVALID_TAGGED_PDF_REMEDIATION_OPTIONS' }); });
