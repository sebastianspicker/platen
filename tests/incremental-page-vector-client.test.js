import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INCREMENTAL_PAGE_VECTOR_LIMITATIONS,
  INCREMENTAL_PAGE_VECTOR_PROFILE,
  INCREMENTAL_PAGE_VECTOR_VALIDATORS,
  validateIncrementalPageVectorResult,
} from '../src/core/pdf-incremental-page-vector-contract.js';
import { LocalHostClient } from '../src/core/local-host-client.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const token = 'c'.repeat(64);
const timestamp = '2026-07-20T12:00:00.000Z';
const request = Object.freeze({
  page: 2,
  rect: Object.freeze({ x: 10, y: 20, width: 580, height: 740 }),
});

function result() {
  return {
    kind: 'pdf-incremental-page-vector',
    sourceDigest: sourceSha256,
    artifact: {
      id: artifactId,
      documentId,
      displayName: 'source-page-vector.pdf',
      mediaType: 'application/pdf',
      size: 1_024,
      sha256: outputSha256,
      operation: {
        schemaVersion: 1,
        id: operationId,
        type: 'pdf-incremental-page-vector',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: { profile: INCREMENTAL_PAGE_VECTOR_PROFILE, ...structuredClone(request) },
        expected: {
          pageCount: 2,
          sourceUnchanged: true,
          sourcePrefixPreserved: true,
          classicIncrementalRevisionAppended: true,
          rasterized: false,
        },
        validation: {
          passed: true,
          validators: [...INCREMENTAL_PAGE_VECTOR_VALIDATORS],
          pageCount: 2,
          outputSha256,
        },
        completedAt: timestamp,
      },
      createdAt: timestamp,
    },
    vector: { page: request.page, rect: { ...request.rect } },
    evidence: {
      sourceDigestReverified: true,
      sourcePrefixPreserved: true,
      classicIncrementalRevisionAppended: true,
      pageCountMatched: true,
      pageTextMatched: true,
      pageBoxesMatched: true,
      targetPageRenderDiffered: true,
      otherPageRendersMatched: true,
      outputUnsigned: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
      localOnly: true,
    },
    limitations: [...INCREMENTAL_PAGE_VECTOR_LIMITATIONS],
  };
}

test('page-vector client sends and validates the exact source-bound request', async () => {
  const calls = [];
  const controller = new AbortController();
  const client = new LocalHostClient({
    fetchImpl: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: result() }), { status: 201 });
    },
  });
  await client.bootstrap();
  const value = await client.runIncrementalPageVector(
    documentId,
    sourceSha256,
    request,
    { signal: controller.signal },
  );
  assert.equal(value.kind, 'pdf-incremental-page-vector');
  assert.equal(calls[1].path, `/api/documents/${documentId}/incremental-page-vector`);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: INCREMENTAL_PAGE_VECTOR_PROFILE,
    sourceSha256,
    ...request,
  });
  assert.throws(() => client.runIncrementalPageVector(documentId, sourceSha256.toUpperCase(), request), TypeError);
  assert.throws(() => client.runIncrementalPageVector(documentId, sourceSha256, { ...request, page: 0 }), TypeError);
  assert.throws(
    () => client.runIncrementalPageVector(documentId, sourceSha256, {
      ...request,
      rect: { ...request.rect, x: 1.5 },
    }),
    TypeError,
  );
});

test('page-vector client rejects crossed request, provenance, and evidence', () => {
  const context = { documentId, sourceSha256, request };
  assert.equal(validateIncrementalPageVectorResult(result(), context).kind, 'pdf-incremental-page-vector');
  const corruptions = [
    (value) => { value.sourceDigest = '0'.repeat(64); },
    (value) => { value.vector.rect.width -= 1; },
    (value) => { value.artifact.operation.parameters.page = 1; },
    (value) => { value.artifact.operation.validation.validators.pop(); },
    (value) => { value.artifact.operation.validation.outputSha256 = '0'.repeat(64); },
    (value) => { value.evidence.localOnly = false; },
    (value) => { value.limitations[0] = 'This is not limited to fixed source geometry. '; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(result());
    corrupt(candidate);
    assert.throws(() => validateIncrementalPageVectorResult(candidate, context), {
      code: 'INVALID_LOCAL_HOST',
    });
  }
});
