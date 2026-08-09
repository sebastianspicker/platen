import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalApplication } from '../scripts/local-host.mjs';
import { HostError } from '../scripts/host/host-error.mjs';
import { createProfessionalContentEditingDelivery } from '../scripts/host/professional-content-editing-delivery.mjs';
import { buildClassicPassivePdf } from '../scripts/host/professional-capability/classic-structure-pdf.mjs';
import { editableTextPdf } from '../scripts/host/professional-capability/fixtures.mjs';
import { createDocumentAndArtifact } from './support/professional-content-editing-delivery.fixtures.mjs';

test('local application routes edit.links through the content-editing wrapper with authoritative source bytes', async (t) => {
  const application = await createLocalApplication({ root: process.cwd(), token: 'd'.repeat(64) });
  t.after(() => application.close());
  const sourcePdf = buildClassicPassivePdf({ pages: 1, width: 100, height: 100 });
  const document = await application.store.createDocument({
    stream: Readable.from([sourcePdf]),
    displayName: 'source.pdf',
  });
  const outcome = await application.professionalCapabilities.deliver('edit.links', {
    documentId: document.id,
    fromPage: 1,
    toPage: 1,
    rect: { left: 0, bottom: 0, right: 1, top: 1 },
  });
  const artifact = application.store.getArtifact(outcome.artifact.id);
  assert.equal(outcome.method, 'production-incremental-goto-link-service');
  assert.equal(outcome.artifact.documentId, document.id);
  assert.equal(artifact.sha256, outcome.outputSha256);
  assert.equal(outcome.pdf.subarray(0, sourcePdf.length).equals(sourcePdf), true);
  await application.store.deleteArtifact(outcome.artifact.id);
});

test('local application routes edit.text through the content-editing wrapper with authoritative source bytes', async (t) => {
  const application = await createLocalApplication({ root: process.cwd(), token: 'e'.repeat(64) });
  t.after(() => application.close());
  const sourcePdf = editableTextPdf('hello world');
  const document = await application.store.createDocument({
    stream: Readable.from([sourcePdf]),
    displayName: 'source-text.pdf',
  });
  const outcome = await application.professionalCapabilities.deliverTextSourceBound('edit.text', document.id, {
    find: 'hello world',
    replace: 'HELLO WORLD',
  });
  const artifact = application.store.getArtifact(outcome.artifact.id);
  assert.equal(outcome.method, 'production-pdf-text-edit-service');
  assert.equal(outcome.artifact.documentId, document.id);
  assert.equal(artifact.sha256, outcome.outputSha256);
  assert.equal(outcome.localOnly, true);
  assert.equal(outcome.sourceSha256, document.sha256);
  assert.equal(outcome.serviceReceipt?.artifact?.id, artifact.id);
  await application.store.deleteArtifact(outcome.artifact.id);
});

test('local application routes edit.find-replace through the content-editing wrapper with authoritative source bytes', async (t) => {
  const application = await createLocalApplication({ root: process.cwd(), token: 'f'.repeat(64) });
  t.after(() => application.close());
  const sourcePdf = editableTextPdf('hello world');
  const document = await application.store.createDocument({
    stream: Readable.from([sourcePdf]),
    displayName: 'source-text.pdf',
  });
  const outcome = await application.professionalCapabilities.deliverTextSourceBound('edit.find-replace', document.id, {
    find: 'hello world',
    replace: 'HELLO WORLD',
  });
  const artifact = application.store.getArtifact(outcome.artifact.id);
  assert.equal(outcome.method, 'production-pdf-text-edit-service');
  assert.equal(outcome.artifact.documentId, document.id);
  assert.equal(artifact.sha256, outcome.outputSha256);
  assert.equal(outcome.localOnly, true);
  assert.equal(outcome.sourceSha256, document.sha256);
  assert.equal(outcome.serviceReceipt?.artifact?.id, artifact.id);
  await application.store.deleteArtifact(outcome.artifact.id);
});

test('content-editing wrapper revokes promoted edit.text output and returns aggregate cleanup errors on failed postflight', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-content-editing-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, artifact, sourceSha256, sourcePath } = await createDocumentAndArtifact({
    root,
    sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sourcePdf: buildClassicPassivePdf({ pages: 1 }),
    artifactId: '11111111-1111-4111-9111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222',
  });
  const calls = { deleteArtifact: 0 };
  const store = {
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
      calls.deleteArtifact += 1;
      if (artifactId === artifact.id) throw new Error('injected delete failure');
      throw new HostError('ARTIFACT_NOT_FOUND', 'Missing retained artifact.', 404);
    },
  };
  let capturedSourceSha256 = null;
  const wrapper = createProfessionalContentEditingDelivery({
    store,
    services: {
      textEdit: {
        async edit() {
          return { artifact, limitations: ['local-only'] };
        },
      },
    },
    deliver: async (_capabilityId, context = {}) => {
      capturedSourceSha256 = context.sourceSha256;
      await context.readArtifact(artifact);
      throw new HostError('POSTFLIGHT_FAILURE', 'Postflight validation failed.', 502);
    },
    list: () => ['edit.links'],
  });
  const error = await wrapper.deliverSourceBound('edit.text', source.id, {
    find: 'hello world',
    replace: 'HELLO WORLD',
  })
    .then(() => null, (value) => value);
  assert.equal(error?.code, 'PROFESSIONAL_CONTENT_EDITING_CLEANUP_FAILED');
  assert.equal(calls.deleteArtifact, 1);
  assert.equal(capturedSourceSha256, sourceSha256);
  assert.equal(error?.cause instanceof AggregateError, true);
  assert.equal(error?.cause.errors.some((entry) => entry?.code === 'POSTFLIGHT_FAILURE'), true);
  assert.equal(error?.cause.errors.some((entry) => entry?.message === 'injected delete failure'), true);
});

test('content-editing wrapper revokes promoted edit.find-replace output and returns aggregate cleanup errors on failed postflight', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-content-editing-find-replace-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, artifact, sourceSha256, sourcePath } = await createDocumentAndArtifact({
    root,
    sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    sourcePdf: editableTextPdf('hello world'),
    artifactId: '22222222-2222-4222-8222-222222222222',
    operationId: '33333333-3333-4333-8333-333333333333',
  });
  const calls = { deleteArtifact: 0 };
  const store = {
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
      calls.deleteArtifact += 1;
      if (artifactId === artifact.id) throw new Error('injected delete failure');
      throw new HostError('ARTIFACT_NOT_FOUND', 'Missing retained artifact.', 404);
    },
  };
  let capturedSourceSha256 = null;
  const wrapper = createProfessionalContentEditingDelivery({
    store,
    services: {
      textEdit: {
        async findReplace() {
          return { artifact, limitations: ['local-only'] };
        },
      },
    },
    deliver: async (_capabilityId, context = {}) => {
      capturedSourceSha256 = context.sourceSha256;
      await context.readArtifact(artifact);
      throw new HostError('POSTFLIGHT_FAILURE', 'Postflight validation failed.', 502);
    },
    list: () => ['edit.text'],
  });
  const error = await wrapper.deliverSourceBound('edit.find-replace', source.id, {
    find: 'hello world',
    replace: 'HELLO WORLD',
  })
    .then(() => null, (value) => value);
  assert.equal(error?.code, 'PROFESSIONAL_CONTENT_EDITING_CLEANUP_FAILED');
  assert.equal(calls.deleteArtifact, 1);
  assert.equal(capturedSourceSha256, sourceSha256);
  assert.equal(error?.cause instanceof AggregateError, true);
  assert.equal(error?.cause.errors.some((entry) => entry?.code === 'POSTFLIGHT_FAILURE'), true);
  assert.equal(error?.cause.errors.some((entry) => entry?.message === 'injected delete failure'), true);
});

test('content-editing wrapper rejects postflight source drift and revokes promoted text-edit artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-content-editing-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, artifact, sourcePath } = await createDocumentAndArtifact({
    root,
    sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sourcePdf: editableTextPdf('hello world'),
    artifactId: '11111111-1111-4111-9111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222',
  });
  const driftedSource = Object.freeze({ ...source, sha256: '0'.repeat(64), size: source.size + 1 });
  const calls = { getDocument: 0, deleteArtifact: 0 };
  const store = {
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
    async deleteArtifact(artifactId) {
      calls.deleteArtifact += 1;
      if (artifactId !== artifact.id) throw new HostError('ARTIFACT_NOT_FOUND', 'Missing retained artifact.', 404);
    },
  };
  const wrapper = createProfessionalContentEditingDelivery({
    store,
    services: {
      textEdit: {
        async edit() {
          return {
            kind: 'pdf-text-edit',
            artifact,
          };
        },
      },
    },
    deliver: async (_capabilityId, context = {}) => ({
      artifact,
      serviceReceipt: {
        artifact,
      },
    }),
    list: () => ['edit.text'],
  });
  const error = await wrapper.deliver('edit.text', {
    documentId: source.id,
    find: 'hello world',
    replace: 'HELLO WORLD',
  }).then(() => null, (value) => value);
  assert.equal(error?.code, 'SOURCE_INTEGRITY_FAILED');
  assert.equal(calls.deleteArtifact, 1);
  assert.equal(calls.getDocument > 1, true);
});

test('content-editing wrapper rejects postflight source drift and revokes promoted find-replace artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-content-editing-find-replace-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, artifact, sourcePath } = await createDocumentAndArtifact({
    root,
    sourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    sourcePdf: editableTextPdf('hello world'),
    artifactId: '44444444-4444-4444-8444-444444444444',
    operationId: '55555555-5555-4555-8555-555555555555',
  });
  const driftedSource = Object.freeze({ ...source, sha256: '1'.repeat(64) });
  const calls = { getDocument: 0, deleteArtifact: 0 };
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
      async deleteArtifact(artifactId) {
        calls.deleteArtifact += 1;
        if (artifactId !== artifact.id) throw new HostError('ARTIFACT_NOT_FOUND', 'Missing retained artifact.', 404);
      },
    },
    services: {
      textEdit: {
        async findReplace() {
          return {
            kind: 'pdf-text-edit',
            artifact,
          };
        },
      },
    },
    deliver: async () => ({
      artifact,
      serviceReceipt: {
        artifact,
      },
    }),
    list: () => ['edit.find-replace'],
  });
  const error = await wrapper.deliver('edit.find-replace', {
    documentId: source.id,
    find: 'hello world',
    replace: 'HELLO WORLD',
  }).then(() => null, (value) => value);
  assert.equal(error?.code, 'SOURCE_INTEGRITY_FAILED');
  assert.equal(calls.deleteArtifact, 1);
  assert.equal(calls.getDocument > 1, true);
});
