import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { writeIncrementalPdfMetadata } from '../scripts/host/pdf-incremental-metadata-writer.mjs';
import { documentMetadataEdit } from '../scripts/host/professional-capability/content-editing-document.mjs';
import {
  INCREMENTAL_METADATA_LIMITATIONS,
  INCREMENTAL_METADATA_PROFILE,
  INCREMENTAL_METADATA_VALIDATORS,
  STANDARD_METADATA_FIELDS,
} from '../src/core/pdf-incremental-metadata-contract.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const documentId = 'aaaaaaaa-1111-4111-8111-111111111111';
const defaultMetadata = Object.freeze({
  title: 'Updated title',
  author: 'Updated author',
  subject: 'Updated subject',
  keywords: 'updated, keywords',
});
const evidence = Object.freeze({
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
});

function makeReceipt(documentId, sourceSha256, outputBytes) {
  return Object.freeze({
    kind: 'pdf-incremental-metadata',
    sourceDigest: sourceSha256,
    artifact: Object.freeze({
      id: '22222222-1111-4111-8111-222222222222',
      documentId,
      displayName: 'source-metadata-edited.pdf',
      mediaType: 'application/pdf',
      size: outputBytes.length,
      sha256: digest(outputBytes),
      operation: Object.freeze({
        schemaVersion: 1,
        id: '33333333-1111-4111-8111-333333333333',
        type: 'pdf-incremental-metadata',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: { profile: INCREMENTAL_METADATA_PROFILE, updatedFields: STANDARD_METADATA_FIELDS },
        expected: { pageCount: 1, sourceUnchanged: true, sourcePrefixPreserved: true, rasterized: false },
        validation: {
          passed: true,
          validators: INCREMENTAL_METADATA_VALIDATORS,
          pageCount: 1,
          outputSha256: digest(outputBytes),
        },
        completedAt: '2026-07-30T00:00:00.000Z',
      }),
      createdAt: '2026-07-30T00:00:00.000Z',
    }),
    metadata: Object.freeze({
      profile: INCREMENTAL_METADATA_PROFILE,
      updatedFields: STANDARD_METADATA_FIELDS,
    }),
    evidence,
    limitations: INCREMENTAL_METADATA_LIMITATIONS,
  });
}

function positiveContext(metadata = defaultMetadata) {
  const sourcePdf = createTextPdf({
    text: 'Metadata edit source fixture for production-bound validation.',
    title: 'Boundary metadata source',
  });
  const sourceSha256 = digest(sourcePdf);
  const writeResult = writeIncrementalPdfMetadata(sourcePdf, metadata);
  const receipt = makeReceipt(documentId, sourceSha256, writeResult.bytes);
  const called = { update: false, read: false, deleted: 0, artifactId: null, metadata: null };
  return {
    sourcePdf,
    sourceSha256,
    output: writeResult.bytes,
    receipt,
    called,
    context: {
      documentId,
      sourcePdf,
      sourceSha256,
      metadata,
      incrementalMetadata: {
        async update(_documentId, request) {
          called.update += 1;
          called.metadata = request;
          return receipt;
        },
      },
      async readArtifact(requestArtifact) {
        called.read += 1;
        assert.deepEqual(requestArtifact, receipt.artifact);
        return writeResult.bytes;
      },
      store: {
        async deleteArtifact(id) {
          called.deleted += 1;
          called.artifactId = id;
        },
      },
    },
  };
}

test('document.metadata-edit production mode requires a reread proof and output-bound semantics', async () => {
  const fixture = positiveContext();
  const result = await documentMetadataEdit(fixture.context);
  assert.equal(result.method, 'production-incremental-metadata-service');
  assert.equal(result.localOnly, true);
  assert.equal(result.retainedBoundaryValidated, true);
  assert.equal(result.trustBoundary.productionService, true);
  assert.equal(result.trustBoundary.artifactReread, true);
  assert.equal(result.trustBoundary.independentSemanticInspection, true);
  assert.equal(result.outputSha256, fixture.receipt.artifact.sha256);
  assert.equal(result.artifact.id, fixture.receipt.artifact.id);
  assert.deepEqual(result.metadata, {
    title: 'Updated title',
    author: 'Updated author',
    subject: 'Updated subject',
    keywords: 'updated, keywords',
  });
  assert.deepEqual(result.pdf, fixture.output);
  assert.equal(result.bytes, fixture.output.length);
  assert.equal(fixture.called.update, 1);
  assert.equal(fixture.called.read, 1);
  assert.equal(fixture.called.deleted, 0);
  assert.deepEqual(result.serviceReceipt, fixture.receipt);
});

test('document.metadata-edit accepts contract-valid nullable metadata fields', async () => {
  const result = await documentMetadataEdit({
    metadata: { title: 'Nullable metadata', author: 'Local author', subject: null, keywords: null },
  });
  assert.equal(result.title, 'Nullable metadata');
  assert.equal(result.author, 'Local author');
  assert.equal(result.productionMode, false);
});

test('document.metadata-edit production mode accepts fully nullable standard metadata fields', async () => {
  const fixture = positiveContext(Object.freeze({
    title: null,
    author: 'Nullable production author',
    subject: 'Updated subject',
    keywords: 'Retained nullable keywords',
  }));
  const result = await documentMetadataEdit({
    ...fixture.context,
    metadata: fixture.context.metadata,
  });
  assert.deepEqual(result.metadata, {
    title: null,
    author: 'Nullable production author',
    subject: 'Updated subject',
    keywords: 'Retained nullable keywords',
  });
  assert.deepEqual(fixture.called.metadata, {
    title: null,
    author: 'Nullable production author',
    subject: 'Updated subject',
    keywords: 'Retained nullable keywords',
  });
  assert.equal(fixture.called.update, 1);
  assert.equal(fixture.called.read, 1);
});

test('document.metadata-edit production mode rejects forged receipt/output and aggregates cleanup failures', async () => {
  const sourcePdf = createTextPdf({ text: 'Metadata hostile source fixture', title: 'Boundary metadata source hostile' });
  const sourceSha256 = digest(sourcePdf);
  const writeResult = writeIncrementalPdfMetadata(sourcePdf, defaultMetadata);
  const validReceipt = makeReceipt(documentId, sourceSha256, writeResult.bytes);

  const staleArtifacts = [];
  await assert.rejects(documentMetadataEdit({
    documentId,
    sourcePdf,
    sourceSha256,
    metadata: defaultMetadata,
    incrementalMetadata: {
      async update() { return { ...validReceipt, sourceDigest: '0'.repeat(64) }; },
    },
    readArtifact: async () => writeResult.bytes,
    store: {
      async deleteArtifact(id) { staleArtifacts.push(id); },
    },
  }), { code: 'METADATA_RECEIPT_INVALID' });
  assert.deepEqual(staleArtifacts, [validReceipt.artifact.id]);

  const cleanup = [];
  await assert.rejects(documentMetadataEdit({
    documentId,
    sourcePdf,
    sourceSha256,
    metadata: defaultMetadata,
    incrementalMetadata: {
      async update() { return validReceipt; },
    },
    readArtifact: async () => Buffer.concat([sourcePdf, Buffer.from('inlined-tail')]),
    store: {
      async deleteArtifact(id) { cleanup.push(id); },
    },
  }), { code: 'METADATA_OUTPUT_INVALID' });
  assert.deepEqual(cleanup, [validReceipt.artifact.id]);

  await assert.rejects(documentMetadataEdit({
    documentId,
    sourcePdf,
    sourceSha256,
    metadata: defaultMetadata,
    incrementalMetadata: {
      async update() { return validReceipt; },
    },
    readArtifact: async () => Buffer.concat([sourcePdf, Buffer.from('inlined-tail')]),
    store: {
      async deleteArtifact() { throw Object.assign(new Error('delete failed'), { code: 'DELETE_FAILED' }); },
    },
  }), (error) => error.code === 'DOCUMENT_METADATA_CLEANUP_FAILED' && error?.cause instanceof AggregateError);
});

test('document.metadata-edit production mode propagates cancellation before service mutation', async () => {
  const sourcePdf = createTextPdf({ text: 'Metadata cancelled source fixture', title: 'Boundary metadata source cancelled' });
  const sourceSha256 = digest(sourcePdf);
  const controller = new AbortController();
  const called = { update: false };
  controller.abort(new Error('cancelled'));
  await assert.rejects(documentMetadataEdit({
    documentId,
    sourcePdf,
    sourceSha256,
    metadata: defaultMetadata,
    signal: controller.signal,
    incrementalMetadata: {
      async update() {
        called.update = true;
        return { kind: 'pdf-incremental-metadata' };
      },
    },
  }), { code: 'JOB_CANCELLED', status: 499 });
  assert.equal(called.update, false);
});
