import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import {
  buildStandardMetadataMutation,
  INCREMENTAL_METADATA_LIMITATIONS,
  INCREMENTAL_METADATA_VALIDATORS,
  validateIncrementalMetadataResult,
  validIncrementalMetadata,
} from '../src/core/pdf-incremental-metadata-contract.js';
import {
  PDF_INCREMENTAL_METADATA_LIMITATIONS,
  PDF_INCREMENTAL_METADATA_VALIDATORS,
} from '../scripts/host/pdf-incremental-metadata-artifact.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const token = 'c'.repeat(64);
const fields = ['title', 'author', 'subject', 'keywords'];
const profile = 'local-classic-incremental-metadata-v1';

function result() {
  return {
    kind: 'pdf-incremental-metadata',
    sourceDigest: sourceSha256,
    artifact: {
      id: artifactId,
      documentId,
      displayName: 'source-metadata-edited.pdf',
      mediaType: 'application/pdf',
      size: 512,
      sha256: outputSha256,
      operation: {
        schemaVersion: 1,
        id: operationId,
        type: 'pdf-incremental-metadata',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: { profile, updatedFields: fields },
        expected: {
          pageCount: 1,
          sourceUnchanged: true,
          sourcePrefixPreserved: true,
          rasterized: false,
        },
        validation: {
          passed: true,
          validators: INCREMENTAL_METADATA_VALIDATORS,
          pageCount: 1,
          outputSha256,
        },
        completedAt: '2026-07-19T00:00:00.000Z',
      },
      createdAt: '2026-07-19T00:00:00.000Z',
    },
    metadata: { profile, updatedFields: fields },
    evidence: {
      sourceDigestReverified: true,
      sourcePrefixPreserved: true,
      priorObjectOffsetsPreserved: true,
      rootReferencePreserved: true,
      freshInfoObjectAllocated: true,
      classicIncrementalRevisionAppended: true,
      popplerMetadataMatched: true,
      pageCountMatched: true,
      pageTextMatched: true,
      pageGeometryMatched: true,
      pageRendersMatched: true,
      outputUnsigned: true,
      xmpAbsent: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
      localOnly: true,
    },
    limitations: INCREMENTAL_METADATA_LIMITATIONS,
  };
}

test('standard metadata builder enforces exact local-writer text policy', () => {
  assert.deepEqual(INCREMENTAL_METADATA_VALIDATORS, PDF_INCREMENTAL_METADATA_VALIDATORS);
  assert.deepEqual(INCREMENTAL_METADATA_LIMITATIONS, PDF_INCREMENTAL_METADATA_LIMITATIONS);
  assert.deepEqual(buildStandardMetadataMutation({
    pdfkitMetadata: { title: 'Résumé', author: '', subject: 'Local', keywords: '' },
  }), { title: 'Résumé', author: null, subject: 'Local', keywords: null });
  assert.equal(validIncrementalMetadata({
    title: 'Local', author: null, subject: null, keywords: 'PDF',
  }), true);
  assert.equal(validIncrementalMetadata({
    title: 'e\u0301', author: null, subject: null, keywords: null,
  }), false);
  assert.equal(validIncrementalMetadata({
    title: 'line\nbreak', author: null, subject: null, keywords: null,
  }), false);
  assert.equal(validIncrementalMetadata({
    title: ' leading', author: null, subject: null, keywords: null,
  }), false);
  assert.equal(validIncrementalMetadata({
    title: 'Local', author: null, subject: null, keywords: null, path: '/tmp/evil',
  }), false);
});

test('local client sends and validates the exact incremental metadata contract', async () => {
  const calls = [];
  const expected = result();
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') {
      return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: expected }), { status: 201 });
  } });
  await client.bootstrap();
  const metadata = { title: 'Local title', author: null, subject: null, keywords: 'PDF' };
  const controller = new AbortController();
  assert.deepEqual(await client.runIncrementalMetadata(
    documentId, sourceSha256, metadata, { signal: controller.signal },
  ), expected);
  assert.equal(calls[1].path, `/api/documents/${documentId}/incremental-metadata`);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile,
    sourceSha256,
    metadata,
  });
  assert.throws(
    () => client.runIncrementalMetadata(documentId, sourceSha256.toUpperCase(), metadata),
    TypeError,
  );
  assert.throws(
    () => client.runIncrementalMetadata(documentId, sourceSha256, { ...metadata, extra: true }),
    TypeError,
  );
  assert.throws(
    () => client.runIncrementalMetadata(documentId, sourceSha256, metadata, { signal: {} }),
    TypeError,
  );
});

test('local client rejects drift in incremental evidence and provenance', async () => {
  const invalid = result();
  invalid.evidence.sourcePrefixPreserved = false;
  const client = new LocalHostClient({ fetchImpl: async (path) => (
    path === '/api/bootstrap'
      ? new Response(JSON.stringify({ sessionToken: token }), { status: 200 })
      : new Response(JSON.stringify({ result: invalid }), { status: 201 })
  ) });
  await client.bootstrap();
  await assert.rejects(client.runIncrementalMetadata(documentId, sourceSha256, {
    title: 'Local', author: null, subject: null, keywords: null,
  }), { code: 'INVALID_LOCAL_HOST' });

  const assertValidatorsRejected = (validators) => {
    const candidate = result(); candidate.artifact.operation.validation.validators = validators;
    assert.throws(
      () => validateIncrementalMetadataResult(candidate, { documentId, sourceSha256 }),
      { code: 'INVALID_LOCAL_HOST' },
    );
  };
  for (let index = 0; index < INCREMENTAL_METADATA_VALIDATORS.length; index += 1) {
    assertValidatorsRejected(INCREMENTAL_METADATA_VALIDATORS.filter((_, candidate) => candidate !== index));
    assertValidatorsRejected(INCREMENTAL_METADATA_VALIDATORS.map(
      (entry, candidate) => candidate === index ? `replacement-${index}` : entry,
    ));
    if (index + 1 < INCREMENTAL_METADATA_VALIDATORS.length) {
      const reordered = [...INCREMENTAL_METADATA_VALIDATORS];
      [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
      assertValidatorsRejected(reordered);
    }
  }
  const assertLimitationsRejected = (limitations) => {
    const candidate = result(); candidate.limitations = limitations;
    assert.throws(
      () => validateIncrementalMetadataResult(candidate, { documentId, sourceSha256 }),
      { code: 'INVALID_LOCAL_HOST' },
    );
  };
  for (let index = 0; index < INCREMENTAL_METADATA_LIMITATIONS.length; index += 1) {
    assertLimitationsRejected(INCREMENTAL_METADATA_LIMITATIONS.filter(
      (_, candidate) => candidate !== index,
    ));
    assertLimitationsRejected(INCREMENTAL_METADATA_LIMITATIONS.map(
      (entry, candidate) => candidate === index ? `Replacement limitation ${index}.` : entry,
    ));
    if (index + 1 < INCREMENTAL_METADATA_LIMITATIONS.length) {
      const reordered = [...INCREMENTAL_METADATA_LIMITATIONS];
      [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
      assertLimitationsRejected(reordered);
    }
  }
});
