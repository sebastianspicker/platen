import assert from 'node:assert/strict';
import test from 'node:test';
import { FULL_PAGE_REDACTION_BATCH_LIMITATIONS, FULL_PAGE_REDACTION_BATCH_PROFILE, FULL_PAGE_REDACTION_LIMITATIONS, FULL_PAGE_REDACTION_VALIDATORS, FULL_PAGE_REDACTION_PROFILE } from '../src/core/pdf-full-page-redaction-contract.js';
import { LocalHostClient } from '../src/core/local-host-client.js';

const token = 'a'.repeat(64);
const documentId = '11111111-1111-4111-8111-111111111111';
const sourceSha256 = 'b'.repeat(64);
const outputSha256 = 'c'.repeat(64);

function result() {
  const operation = {
    schemaVersion: 1,
    id: '22222222-2222-4222-8222-222222222222',
    type: 'pdf-full-page-redaction',
    inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
    parameters: { profile: FULL_PAGE_REDACTION_PROFILE, page: 2 },
    expected: { pageCount: 2, sourceUnchanged: true, closedCompactRewrite: true, fullPageOnly: true },
    validation: {
      passed: true, validators: FULL_PAGE_REDACTION_VALIDATORS, pageCount: 2,
      targetPage: 2, outputSha256,
    },
    completedAt: '2026-07-20T00:00:00.000Z',
  };
  return {
    kind: 'pdf-full-page-redaction', sourceDigest: sourceSha256,
    artifact: {
      id: '33333333-3333-4333-8333-333333333333', documentId,
      displayName: 'redacted.pdf', mediaType: 'application/pdf', size: 128,
      sha256: outputSha256, operation, createdAt: '2026-07-20T00:00:00.000Z',
    },
    redaction: { page: 2, fullPage: true },
    evidence: {
      sourceDigestReverified: true, closedCompactRewrite: true,
      targetContentResourcesRemoved: true, pageCountMatched: true,
      targetTextEmpty: true, targetRenderBlack: true,
      nonTargetTextRenderMatched: true, outputUnsigned: true,
      attachmentsAbsent: true, urlsAbsent: true, artifactDigestBound: true,
      sourceUnchanged: true, localOnly: true,
    },
    limitations: FULL_PAGE_REDACTION_LIMITATIONS,
  };
}

test('local host client posts fixed full-page redaction request and validates the result envelope', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: result() }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } });
  await client.bootstrap();
  const controller = new AbortController();
  const value = await client.runFullPageRedaction(documentId, sourceSha256, { page: 2 }, { signal: controller.signal });
  assert.equal(value.kind, 'pdf-full-page-redaction');
  assert.equal(calls[1].path, `/api/documents/${documentId}/full-page-redaction`);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: FULL_PAGE_REDACTION_PROFILE, sourceSha256, page: 2,
  });
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.throws(() => client.runFullPageRedaction(documentId, sourceSha256.toUpperCase(), { page: 2 }), TypeError);
  assert.throws(() => client.runFullPageRedaction(documentId, sourceSha256, { page: 0 }), TypeError);
  assert.throws(() => client.runFullPageRedaction(documentId, sourceSha256, { page: 2, extra: true }), TypeError);
});

test('local host client rejects a tampered full-page redaction result', async () => {
  const client = new LocalHostClient({ fetchImpl: async (path) => {
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    const invalid = result(); invalid.evidence.targetRenderBlack = false;
    return new Response(JSON.stringify({ result: invalid }), { status: 201 });
  } });
  await client.bootstrap();
  await assert.rejects(client.runFullPageRedaction(documentId, sourceSha256, { page: 2 }), { code: 'INVALID_LOCAL_HOST' });
});

function batchResult() {
  const outputSha256 = 'c'.repeat(64);
  const operation = {
    schemaVersion: 1, id: '22222222-2222-4222-8222-222222222222', type: 'pdf-full-page-redaction-batch',
    inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
    parameters: { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, pages: [1, 3] },
    expected: { pageCount: 3, sourceUnchanged: true, closedCompactRewrite: true, fullPageOnly: true },
    validation: { passed: true, validators: FULL_PAGE_REDACTION_VALIDATORS, pageCount: 3, targetPages: [1, 3], outputSha256 },
    completedAt: '2026-07-20T00:00:00.000Z',
  };
  return {
    kind: 'pdf-full-page-redaction-batch', sourceDigest: sourceSha256, pages: [1, 3],
    artifact: { id: '33333333-3333-4333-8333-333333333333', documentId, displayName: 'redacted-batch.pdf', mediaType: 'application/pdf', size: 128, sha256: outputSha256, operation, createdAt: '2026-07-20T00:00:00.000Z' },
    evidence: { sourceDigestReverified: true, closedCompactRewrite: true, targetContentResourcesRemoved: true, pageCountMatched: true, targetTextEmpty: true, targetPagesBlack: true, nonTargetTextRenderMatched: true, outputUnsigned: true, attachmentsAbsent: true, urlsAbsent: true, artifactDigestBound: true, sourceUnchanged: true, fullPageOnly: true, localOnly: true },
    limitations: FULL_PAGE_REDACTION_BATCH_LIMITATIONS,
  };
}

test('local host client posts and validates one atomic full-page redaction batch', async () => {
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: batchResult() }), { status: 201 });
  } });
  await client.bootstrap();
  const value = await client.runFullPageRedactionBatch(documentId, sourceSha256, { pages: [1, 3] });
  assert.equal(value.kind, 'pdf-full-page-redaction-batch');
  assert.equal(calls[1].path, `/api/documents/${documentId}/full-page-redaction-batch`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { profile: FULL_PAGE_REDACTION_BATCH_PROFILE, sourceSha256, pages: [1, 3] });
  assert.throws(() => client.runFullPageRedactionBatch(documentId, sourceSha256, { pages: [2, 1] }), TypeError);
});
