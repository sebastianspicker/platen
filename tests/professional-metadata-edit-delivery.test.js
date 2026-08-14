import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalApplication } from '../scripts/local-host.mjs';
import { HostError } from '../scripts/host/host-error.mjs';
import { createProfessionalContentEditingDelivery } from '../scripts/host/professional-content-editing-delivery.mjs';
import { editableTextPdf } from '../scripts/host/professional-capability/fixtures.mjs';
import { createDocumentAndArtifact } from './support/professional-content-editing-delivery.fixtures.mjs';

test('local application routes document.metadata-edit through the content-editing wrapper with authoritative source bytes', async (t) => {
  const application = await createLocalApplication({ root: process.cwd(), token: 'g'.repeat(64) });
  t.after(() => application.close());
  const sourcePdf = editableTextPdf('metadata source');
  const document = await application.store.createDocument({
    stream: Readable.from([sourcePdf]),
    displayName: 'source-metadata.pdf',
  });
  const outcome = await application.professionalCapabilities.deliverContentEditingSourceBound('document.metadata-edit', document.id, {
    metadata: {
      title: 'Updated title',
      author: 'Updated author',
      subject: 'Updated subject',
      keywords: 'updated, keywords',
    },
  });
  const artifact = application.store.getArtifact(outcome.artifact.id);
  assert.equal(outcome.method, 'production-incremental-metadata-service');
  assert.equal(outcome.artifact.documentId, document.id);
  assert.equal(artifact.sha256, outcome.outputSha256);
  assert.equal(outcome.localOnly, true);
  assert.equal(outcome.sourceSha256, document.sha256);
  assert.deepEqual(outcome.metadata, {
    title: 'Updated title',
    author: 'Updated author',
    subject: 'Updated subject',
    keywords: 'updated, keywords',
  });
  assert.equal(outcome.serviceReceipt?.artifact?.id, artifact.id);
  await application.store.deleteArtifact(outcome.artifact.id);
});

test('content-editing wrapper rejects document.metadata-edit forged receipt and aggregates cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-content-metadata-forged-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, sourcePath, artifact } = await createDocumentAndArtifact({
    root,
    sourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    sourcePdf: editableTextPdf('hello world'),
    artifactId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  });
  const calls = { deleteArtifact: 0 };
  const wrapper = createProfessionalContentEditingDelivery({
    store: {
      async verifySource(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
      },
      getDocument(documentId) { if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404); return source; },
      getSourcePath(documentId) { if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source path.', 404); return sourcePath; },
    getArtifact(artifactId) {
        if (![artifact.id, `${artifact.id}-forged`].includes(artifactId)) throw new HostError('ARTIFACT_NOT_FOUND', 'Missing retained artifact.', 404);
        return artifact;
      },
      async deleteArtifact(artifactId) {
        calls.deleteArtifact += 1;
        if (artifactId !== artifact.id) return;
      },
    },
    services: {
      incrementalMetadata: {
        async update() {
          return { artifact, limitations: ['local-only'] };
        },
      },
    },
    deliver: async (_capabilityId, context = {}) => {
      const forgedArtifact = { ...artifact, id: `${artifact.id}-forged` };
      await context.readArtifact(forgedArtifact);
      return {
        artifact,
        serviceReceipt: {
          artifact: forgedArtifact,
        },
        metadata: context.metadata,
      };
    },
    list: () => ['document.metadata-edit'],
  });
  const error = await wrapper.deliverSourceBound('document.metadata-edit', source.id, {
    metadata: {
      title: 'Updated title',
      author: 'Updated author',
      subject: 'Updated subject',
      keywords: 'updated, keywords',
    },
  })
    .then(() => null, (value) => value);
  assert.equal(error?.code, 'PROFESSIONAL_CONTENT_EDITING_RETAINED_INVALID');
  assert.equal(calls.deleteArtifact, 1);
});

test('content-editing wrapper revokes promoted metadata-edit output and returns aggregate cleanup errors on failed postflight', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-content-metadata-postflight-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, sourceSha256, sourcePath, artifact } = await createDocumentAndArtifact({
    root,
    sourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    sourcePdf: editableTextPdf('hello world'),
    artifactId: '11111111-1111-4111-8111-111111111112',
    operationId: '22222222-2222-4222-8222-222222222223',
  });
  let capturedSourceSha256 = null;
  const wrapper = createProfessionalContentEditingDelivery({
    store: {
      async verifySource(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
      },
      getDocument(documentId) { if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404); return source; },
      getSourcePath(documentId) { if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source path.', 404); return sourcePath; },
      getArtifact(artifactId) {
        if (artifactId !== artifact.id) throw new HostError('ARTIFACT_NOT_FOUND', 'Missing retained artifact.', 404);
        return artifact;
      },
      async deleteArtifact(artifactId) {
        if (artifactId === artifact.id) throw new Error('injected delete failure');
      },
    },
    services: {
      incrementalMetadata: {
        async update() {
          return { artifact, limitations: ['local-only'] };
        },
      },
    },
    deliver: async (_capabilityId, context = {}) => {
      capturedSourceSha256 = context.sourceSha256;
      await context.readArtifact(artifact);
      throw new HostError('POSTFLIGHT_FAILURE', 'Postflight validation failed.', 502);
    },
    list: () => ['document.metadata-edit'],
  });
  const error = await wrapper.deliverSourceBound('document.metadata-edit', source.id, {
    metadata: {
      title: 'Updated title',
      author: 'Updated author',
      subject: 'Updated subject',
      keywords: 'updated, keywords',
    },
  })
    .then(() => null, (value) => value);
  assert.equal(error?.code, 'PROFESSIONAL_CONTENT_EDITING_CLEANUP_FAILED');
  assert.equal(error?.cause instanceof AggregateError, true);
  assert.equal(error?.cause.errors.some((entry) => entry?.code === 'POSTFLIGHT_FAILURE'), true);
  assert.equal(capturedSourceSha256, sourceSha256);
});

test('content-editing wrapper rejects postflight source drift and revokes promoted metadata-edit artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-content-metadata-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, sourcePath, artifact } = await createDocumentAndArtifact({
    root,
    sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    sourcePdf: editableTextPdf('metadata drift'),
    artifactId: '33333333-3333-4333-8333-333333333333',
    operationId: '44444444-4444-4444-8444-444444444444',
  });
  const driftedSource = Object.freeze({ ...source, sha256: '0'.repeat(64), size: source.size + 1 });
  const calls = { getDocument: 0 };
  const wrapper = createProfessionalContentEditingDelivery({
    store: {
      async verifySource(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
      },
      getDocument(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
        calls.getDocument += 1;
        return calls.getDocument > 1 ? driftedSource : source;
      },
      getSourcePath(documentId) { if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source path.', 404); return sourcePath; },
      getArtifact(artifactId) {
        if (artifactId !== artifact.id) throw new HostError('ARTIFACT_NOT_FOUND', 'Missing retained artifact.', 404);
        return artifact;
      },
      async deleteArtifact() {},
    },
    services: {
      incrementalMetadata: {
        async update() {
          return { artifact, limitations: ['local-only'] };
        },
      },
    },
    deliver: async () => ({
      artifact,
      serviceReceipt: { artifact },
      metadata: {
        title: 'Updated title',
        author: 'Updated author',
        subject: 'Updated subject',
        keywords: 'updated, keywords',
      },
    }),
    list: () => ['document.metadata-edit'],
  });
  const error = await wrapper.deliverSourceBound('document.metadata-edit', source.id, {
    metadata: {
      title: 'Updated title',
      author: 'Updated author',
      subject: 'Updated subject',
      keywords: 'updated, keywords',
    },
  }).then(() => null, (value) => value);
  assert.equal(error?.code, 'SOURCE_INTEGRITY_FAILED');
  assert.equal(calls.getDocument > 1, true);
});
