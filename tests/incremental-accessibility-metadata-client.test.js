import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import {
  INCREMENTAL_ACCESSIBILITY_METADATA_FIELDS,
  INCREMENTAL_ACCESSIBILITY_METADATA_LIMITATIONS,
  INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE,
  INCREMENTAL_ACCESSIBILITY_METADATA_VALIDATORS,
} from '../src/core/pdf-incremental-accessibility-metadata-contract.js';

const token = 'a'.repeat(64);
const sourceSha256 = 'b'.repeat(64);
const outputSha256 = 'c'.repeat(64);
const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const requestSha256 = createHash('sha256').update(JSON.stringify({
  language: 'en-latn-us',
  title: 'Accessible PDF',
})).digest('hex');

function result() {
  return {
    kind: 'pdf-incremental-accessibility-metadata',
    sourceDigest: sourceSha256,
    artifact: {
      id: artifactId,
      documentId,
      displayName: 'document-language-title-updated.pdf',
      mediaType: 'application/pdf',
      size: 128,
      sha256: outputSha256,
      createdAt: '2026-07-20T00:00:00.000Z',
      operation: {
        schemaVersion: 1,
        id: operationId,
        type: 'pdf-incremental-accessibility-metadata',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: {
          profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE,
          updatedFields: [...INCREMENTAL_ACCESSIBILITY_METADATA_FIELDS],
          requestSha256,
        },
        expected: {
          pageCount: 1,
          sourceUnchanged: true,
          sourcePrefixPreserved: true,
          rasterized: false,
        },
        validation: {
          passed: true,
          validators: [...INCREMENTAL_ACCESSIBILITY_METADATA_VALIDATORS],
          pageCount: 1,
          outputSha256,
        },
        completedAt: '2026-07-20T00:00:00.000Z',
      },
    },
    metadata: {
      profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE,
      updatedFields: [...INCREMENTAL_ACCESSIBILITY_METADATA_FIELDS],
      requestSha256,
    },
    evidence: {
      sourceDigestReverified: true,
      sourcePrefixPreserved: true,
      appendOnlyHistoryRetained: true,
      rawLanguageAndTitleMatched: true,
      outputUnsigned: true,
      pageCountMatched: true,
      pageTextMatched: true,
      pageGeometryMatched: true,
      pageRendersMatched: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
      localOnly: true,
    },
    limitations: [...INCREMENTAL_ACCESSIBILITY_METADATA_LIMITATIONS],
  };
}

test('accessibility metadata client sends the exact language/title request and rejects result drift', async () => {
  const calls = []; let response = result();
  const client = new LocalHostClient({
    fetchImpl: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/api/bootstrap') {
        return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: response }), { status: 201 });
    },
  });
  await client.bootstrap();
  const value = await client.runIncrementalAccessibilityMetadata(
    documentId,
    sourceSha256,
    { language: 'en-latn-us', title: 'Accessible PDF' },
  );
  assert.equal(value.kind, 'pdf-incremental-accessibility-metadata');
  assert.equal(calls[1].path, `/api/documents/${documentId}/incremental-accessibility-metadata`);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE,
    sourceSha256,
    metadata: { language: 'en-latn-us', title: 'Accessible PDF' },
  });
  response = result();
  await assert.rejects(
    client.runIncrementalAccessibilityMetadata(
      documentId,
      sourceSha256,
      { language: 'de', title: 'Accessible PDF' },
    ),
    { code: 'INVALID_LOCAL_HOST' },
  );
  await assert.rejects(
    client.runIncrementalAccessibilityMetadata(
      documentId,
      sourceSha256,
      { language: 'en-latn-us', title: 'Different title' },
    ),
    { code: 'INVALID_LOCAL_HOST' },
  );
  response = result();
  response.artifact.operation.validation.validators.reverse();
  await assert.rejects(
    client.runIncrementalAccessibilityMetadata(
      documentId,
      sourceSha256,
      { language: 'en', title: 'Accessible PDF' },
    ),
    { code: 'INVALID_LOCAL_HOST' },
  );
  assert.throws(
    () => client.runIncrementalAccessibilityMetadata(
      documentId,
      sourceSha256,
      { language: 'EN', title: 'Accessible PDF' },
    ),
    TypeError,
  );
});
