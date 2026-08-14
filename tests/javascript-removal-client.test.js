import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PDF_JAVASCRIPT_REMOVAL_LIMITATIONS as HOST_LIMITATIONS,
} from '../scripts/host/pdf-javascript-removal-artifact.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import {
  PDF_JAVASCRIPT_REMOVAL_LIMITATIONS, PDF_JAVASCRIPT_REMOVAL_PROFILE,
  PDF_JAVASCRIPT_REMOVAL_VALIDATORS, validatePdfJavaScriptRemovalResult,
} from '../src/core/pdf-javascript-removal-contract.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64); const outputSha256 = 'b'.repeat(64);
const token = 'c'.repeat(64); const timestamp = '2026-07-20T12:00:00.000Z';

function result() {
  return {
    kind: 'pdf-javascript-removal', sourceDigest: sourceSha256,
    artifact: {
      id: artifactId, documentId, displayName: 'source-javascript-removed.pdf',
      mediaType: 'application/pdf', size: 1_024, sha256: outputSha256,
      operation: {
        schemaVersion: 1, id: operationId, type: 'pdf-javascript-removal',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: { profile: PDF_JAVASCRIPT_REMOVAL_PROFILE },
        expected: { pageCount: 2, sourceUnchanged: true, closedClassicRevision: true, priorRevisionsAbsent: true, rasterized: false },
        validation: { passed: true, validators: [...PDF_JAVASCRIPT_REMOVAL_VALIDATORS], pageCount: 2, outputSha256 },
        completedAt: timestamp,
      }, createdAt: timestamp,
    },
    removal: { profile: PDF_JAVASCRIPT_REMOVAL_PROFILE, removedLocus: 'open-action' },
    evidence: {
      sourceDigestReverified: true, closedClassicRevision: true,
      priorRevisionsAbsent: true, javascriptSurfacesAbsent: true,
      removedReferencesUnresolvable: true, pageCountMatched: true,
      pageTextMatched: true, pageBoxesMatched: true,
      pageValidationRendersMatched: true, outputUnsigned: true,
      artifactDigestBound: true, sourceUnchanged: true, localOnly: true,
    }, limitations: [...PDF_JAVASCRIPT_REMOVAL_LIMITATIONS],
  };
}

test('JavaScript-removal client sends the fixed source-bound request', async () => {
  assert.deepEqual(PDF_JAVASCRIPT_REMOVAL_LIMITATIONS, HOST_LIMITATIONS);
  const calls = []; const controller = new AbortController();
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: result() }), { status: 201 });
  } });
  await client.bootstrap();
  const value = await client.runJavaScriptRemoval(documentId, sourceSha256, { signal: controller.signal });
  assert.equal(value.kind, 'pdf-javascript-removal');
  assert.equal(calls[1].path, `/api/documents/${documentId}/javascript-removal`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { profile: PDF_JAVASCRIPT_REMOVAL_PROFILE, sourceSha256 });
  assert.equal(calls[1].options.signal, controller.signal);
  assert.throws(() => client.runJavaScriptRemoval(documentId, sourceSha256.toUpperCase()), TypeError);
});

test('JavaScript-removal client rejects crossed or exaggerated host evidence', () => {
  const context = { documentId, sourceSha256 };
  assert.equal(validatePdfJavaScriptRemovalResult(result(), context).kind, 'pdf-javascript-removal');
  const corruptions = [
    (value) => { value.sourceDigest = '0'.repeat(64); },
    (value) => { value.removal.removedLocus = 'all-actions'; },
    (value) => { value.artifact.operation.parameters.profile = 'custom'; },
    (value) => { value.artifact.operation.validation.pageCount = 1; },
    (value) => { value.evidence.priorRevisionsAbsent = false; },
    (value) => { value.limitations[1] = 'General sanitization completed.'; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(result()); corrupt(candidate);
    assert.throws(() => validatePdfJavaScriptRemovalResult(candidate, context), { code: 'INVALID_LOCAL_HOST' });
  }
});
