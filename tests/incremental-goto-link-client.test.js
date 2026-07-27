import assert from 'node:assert/strict';
import test from 'node:test';
import { PDF_INCREMENTAL_GOTO_LINK_LIMITATIONS } from '../scripts/host/pdf-incremental-goto-link-artifact.mjs';
import { LocalHostClient } from '../src/core/local-host-client.js';
import {
  INCREMENTAL_GOTO_LINK_LIMITATIONS,
  INCREMENTAL_GOTO_LINK_PROFILE,
  INCREMENTAL_GOTO_LINK_VALIDATORS,
  validateIncrementalGoToLinkResult,
} from '../src/core/pdf-incremental-goto-link-contract.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const token = 'c'.repeat(64);
const timestamp = '2026-07-20T12:00:00.000Z';
const request = Object.freeze({
  sourcePage: 1, targetPage: 2,
  rect: Object.freeze({ left: 10, bottom: 20, right: 80, top: 90 }),
});

function result() {
  return {
    kind: 'pdf-incremental-goto-link', sourceDigest: sourceSha256,
    artifact: {
      id: artifactId, documentId, displayName: 'source-goto-link.pdf',
      mediaType: 'application/pdf', size: 1_024, sha256: outputSha256,
      operation: {
        schemaVersion: 1, id: operationId, type: 'pdf-incremental-goto-link',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: { profile: INCREMENTAL_GOTO_LINK_PROFILE, ...structuredClone(request) },
        expected: {
          pageCount: 2, sourceUnchanged: true, sourcePrefixPreserved: true,
          classicIncrementalRevisionAppended: true, rasterized: false,
        },
        validation: {
          passed: true, validators: [...INCREMENTAL_GOTO_LINK_VALIDATORS],
          pageCount: 2, outputSha256,
        },
        completedAt: timestamp,
      },
      createdAt: timestamp,
    },
    link: structuredClone(request),
    evidence: {
      sourceDigestReverified: true, sourcePrefixPreserved: true,
      classicIncrementalRevisionAppended: true, pageCountMatched: true,
      pageTextMatched: true, pageBoxesMatched: true,
      pageValidationRendersMatched: true, outputUnsigned: true,
      artifactDigestBound: true, sourceUnchanged: true, localOnly: true,
    },
    limitations: [...INCREMENTAL_GOTO_LINK_LIMITATIONS],
  };
}

test('incremental GoTo-link client limitations match the host artifact', () => {
  assert.deepEqual(INCREMENTAL_GOTO_LINK_LIMITATIONS, PDF_INCREMENTAL_GOTO_LINK_LIMITATIONS);
});

test('incremental GoTo-link client sends the exact source-bound request', async () => {
  const calls = []; const controller = new AbortController();
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') {
      return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: result() }), { status: 201 });
  } });
  await client.bootstrap();
  const value = await client.runIncrementalGoToLink(
    documentId, sourceSha256, request, { signal: controller.signal },
  );
  assert.equal(value.kind, 'pdf-incremental-goto-link');
  assert.equal(calls[1].path, `/api/documents/${documentId}/incremental-goto-link`);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: INCREMENTAL_GOTO_LINK_PROFILE, sourceSha256, ...request,
  });
  assert.throws(() => client.runIncrementalGoToLink(
    documentId, sourceSha256.toUpperCase(), request,
  ), TypeError);
  assert.throws(() => client.runIncrementalGoToLink(
    documentId, sourceSha256, { ...request, targetPage: 0 },
  ), TypeError);
  assert.throws(() => client.runIncrementalGoToLink(
    documentId, sourceSha256, { ...request, rect: { ...request.rect, right: 10 } },
  ), TypeError);
});

test('incremental GoTo-link client rejects crossed provenance and evidence', () => {
  const context = { documentId, sourceSha256, request };
  assert.equal(
    validateIncrementalGoToLinkResult(result(), context).kind,
    'pdf-incremental-goto-link',
  );
  const corruptions = [
    (value) => { value.sourceDigest = '0'.repeat(64); },
    (value) => { value.artifact.documentId = artifactId; },
    (value) => { value.link.rect.right -= 1; },
    (value) => { value.artifact.operation.parameters.targetPage = 1; },
    (value) => {
      value.artifact.operation.expected.pageCount = 1;
      value.artifact.operation.validation.pageCount = 1;
    },
    (value) => { value.artifact.operation.validation.validators.pop(); },
    (value) => { value.artifact.operation.validation.outputSha256 = '0'.repeat(64); },
    (value) => { value.evidence.pageBoxesMatched = false; },
    (value) => { value.limitations[1] = 'General hyperlink support is available.'; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(result()); corrupt(candidate);
    assert.throws(() => validateIncrementalGoToLinkResult(candidate, context), {
      code: 'INVALID_LOCAL_HOST',
    });
  }
});
