import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import {
  PDF_ATTACHMENT_REMOVAL_LIMITATIONS as HOST_LIMITATIONS,
  PDF_ATTACHMENT_REMOVAL_VALIDATORS as HOST_VALIDATORS,
} from '../scripts/host/pdf-attachment-removal-artifact.mjs';
import {
  PDF_ATTACHMENT_REMOVAL_LIMITATIONS,
  PDF_ATTACHMENT_REMOVAL_PROFILE,
  PDF_ATTACHMENT_REMOVAL_VALIDATORS,
  validatePdfAttachmentRemovalResult,
} from '../src/core/pdf-attachment-removal-contract.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const nameSha256 = 'c'.repeat(64);
const contentSha256 = 'd'.repeat(64);
const token = 'e'.repeat(64);
const timestamp = '2026-07-20T12:00:00.000Z';

test('attachment-removal browser proof constants exactly match the host', () => {
  assert.deepEqual(PDF_ATTACHMENT_REMOVAL_VALIDATORS, HOST_VALIDATORS);
  assert.deepEqual(PDF_ATTACHMENT_REMOVAL_LIMITATIONS, HOST_LIMITATIONS);
});

function result() {
  const removal = {
    profile: PDF_ATTACHMENT_REMOVAL_PROFILE,
    nameSha256, contentSha256, contentBytes: 42,
  };
  return {
    kind: 'pdf-document-attachment-removal', sourceDigest: sourceSha256,
    artifact: {
      id: artifactId, documentId, displayName: 'source-attachment-removed.pdf',
      mediaType: 'application/pdf', size: 1_024, sha256: outputSha256,
      operation: {
        schemaVersion: 1, id: operationId, type: 'pdf-document-attachment-removal',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: { ...removal },
        expected: {
          pageCount: 1, attachmentRemoved: true, sourceUnchanged: true,
          closedClassicRewrite: true, priorRevisionsAbsent: true, rasterized: false,
        },
        validation: {
          passed: true, validators: [...PDF_ATTACHMENT_REMOVAL_VALIDATORS],
          pageCount: 1, outputSha256,
        },
        completedAt: timestamp,
      },
      createdAt: timestamp,
    },
    removal,
    evidence: {
      sourceDigestReverified: true, attachmentMatchedBefore: true,
      attachmentContentDigestBound: true, attachmentAbsentAfter: true,
      logicalDeletionVerified: true, closedClassicRewriteVerified: true,
      pageCountMatched: true, pageTextMatched: true, pageBoxesMatched: true,
      pageValidationRendersMatched: true, outputUnsigned: true,
      artifactDigestBound: true, sourceUnchanged: true, localOnly: true,
    },
    limitations: [...PDF_ATTACHMENT_REMOVAL_LIMITATIONS],
  };
}

test('attachment-removal client sends only the fixed source-bound request', async () => {
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
  const value = await client.runAttachmentRemoval(
    documentId, sourceSha256, { signal: controller.signal },
  );
  assert.equal(value.removal.contentSha256, contentSha256);
  assert.equal(calls[1].path, `/api/documents/${documentId}/attachment-removal`);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: PDF_ATTACHMENT_REMOVAL_PROFILE, sourceSha256,
  });
  assert.equal(calls[1].options.signal, controller.signal);
  assert.throws(
    () => client.runAttachmentRemoval(documentId, sourceSha256, { extra: true }),
    TypeError,
  );
});

test('attachment-removal client rejects leakage and exaggerated evidence', () => {
  const context = { documentId, sourceSha256 };
  assert.equal(validatePdfAttachmentRemovalResult(result(), context).kind,
    'pdf-document-attachment-removal');
  const corruptions = [
    (value) => { value.removal.name = 'private.txt'; },
    (value) => { value.removal.contentSha256 = '0'.repeat(64); },
    (value) => { value.artifact.operation.parameters.contentBytes = 43; },
    (value) => { value.artifact.operation.expected.attachmentRemoved = false; },
    (value) => { value.evidence.attachmentAbsentAfter = false; },
    (value) => { value.limitations[2] = 'General attachment management.'; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(result());
    corrupt(candidate);
    assert.throws(
      () => validatePdfAttachmentRemovalResult(candidate, context),
      { code: 'INVALID_LOCAL_HOST' },
    );
  }
});
