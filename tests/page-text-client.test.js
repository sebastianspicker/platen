import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PDF_PAGE_TEXT_LIMITATIONS, PDF_PAGE_TEXT_PROFILE, PDF_PAGE_TEXT_VALIDATORS,
  validatePageTextResult,
} from '../src/core/pdf-page-text-contract.js';
import { LocalHostClient } from '../src/core/local-host-client.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64); const outputSha256 = 'b'.repeat(64);
const token = 'c'.repeat(64); const timestamp = '2026-07-20T12:00:00.000Z';
const request = Object.freeze({ page: 2, x: 36, y: 72, size: 12, text: 'Hello PDF' });
const textSha256 = createHash('sha256').update(request.text).digest('hex');

function result() {
  return {
    kind: 'pdf-page-text-run', sourceDigest: sourceSha256,
    artifact: {
      id: artifactId, documentId, displayName: 'source-page-text.pdf',
      mediaType: 'application/pdf', size: 1_024, sha256: outputSha256,
      operation: {
        schemaVersion: 1, id: operationId, type: 'pdf-incremental-page-text',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: { profile: PDF_PAGE_TEXT_PROFILE, page: 2, x: 36, y: 72, size: 12, textSha256 },
        expected: { pageCount: 2, sourceUnchanged: true, sourcePrefixPreserved: true, classicIncrementalRevisionAppended: true, rasterized: false },
        validation: { passed: true, validators: [...PDF_PAGE_TEXT_VALIDATORS], pageCount: 2, renderedPages: 2, outputSha256 },
        completedAt: timestamp,
      },
      createdAt: timestamp,
    },
    page: 2, text: { page: 2, x: 36, y: 72, size: 12, textSha256 },
    evidence: {
      sourceDigestReverified: true, sourcePrefixPreserved: true,
      writerProofVerified: true, pageCountMatched: true, pageBoxesMatched: true,
      targetPageTextMatched: true, targetPageRenderDiffered: true,
      otherPageRendersMatched: true, outputUnsigned: true,
      artifactDigestBound: true, sourceUnchanged: true, localOnly: true,
    },
    limitations: [...PDF_PAGE_TEXT_LIMITATIONS], rasterized: false,
    historicalBytesRetained: true,
  };
}

test('page-text client hashes, sends, and validates the exact request', async () => {
  const calls = []; const controller = new AbortController();
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: result() }), { status: 201 });
  } });
  await client.bootstrap();
  assert.equal((await client.runPageText(documentId, sourceSha256, request, { signal: controller.signal })).kind, 'pdf-page-text-run');
  assert.equal(calls[1].path, `/api/documents/${documentId}/page-text`);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), { profile: PDF_PAGE_TEXT_PROFILE, sourceSha256, ...request });
  assert.throws(() => client.runPageText(documentId, sourceSha256, { ...request, text: 'bad\ntext' }), TypeError);
});

test('page-text client rejects crossed request, provenance, and evidence', () => {
  const context = { documentId, sourceSha256, request, textSha256 };
  assert.equal(validatePageTextResult(result(), context).kind, 'pdf-page-text-run');
  for (const corrupt of [
    (value) => { value.text.textSha256 = '0'.repeat(64); },
    (value) => { value.artifact.operation.parameters.x = 37; },
    (value) => { value.artifact.operation.validation.renderedPages = 1; },
    (value) => { value.evidence.localOnly = false; },
    (value) => { value.historicalBytesRetained = false; },
  ]) {
    const candidate = structuredClone(result()); corrupt(candidate);
    assert.throws(() => validatePageTextResult(candidate, context), { code: 'INVALID_LOCAL_HOST' });
  }
});
