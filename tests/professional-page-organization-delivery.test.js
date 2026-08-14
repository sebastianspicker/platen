import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLocalApplication } from '../scripts/local-host.mjs';
import { HostError } from '../scripts/host/host-error.mjs';
import { createProfessionalPageOrganizationDelivery } from '../scripts/host/professional-page-organization-delivery.mjs';
import { buildClassicPassivePdf } from '../scripts/host/professional-capability/classic-structure-pdf.mjs';
import * as support from './host-pdfkit-test-support.js';
import { createDocumentAndArtifact } from './support/professional-page-organization-delivery.fixtures.mjs';

const CAN_RUN = support.canRunIntegration();

async function assertLocalApplication(t) {
  if (!CAN_RUN) {
    t.skip('PDFKit helper integration tooling is unavailable.');
  }
}

test('local application routes pages.page-boxes through source-bound page-organization delivery with authoritative source bytes', async (t) => {
  await assertLocalApplication(t);
  const application = await createLocalApplication({ root: process.cwd(), token: 'k'.repeat(64) });
  t.after(() => application.close());
  const sourcePdf = buildClassicPassivePdf({ pages: 1, width: 100, height: 100 });
  const document = await application.store.createDocument({ stream: Readable.from([sourcePdf]), displayName: 'source.pdf' });
  const outcome = await application.professionalCapabilities.deliverPageOrganizationSourceBound('pages.page-boxes', document.id, {
    sourceSha256: document.sha256,
    page: 1,
    boxType: 'crop',
    box: { left: 0, bottom: 0, right: 90, top: 90 },
  });
  const artifact = application.store.getArtifact(outcome.artifact.id);
  assert.equal(outcome.method, 'source-bound-pdfkit-crop-box');
  assert.equal(outcome.artifact.documentId, document.id);
  assert.equal(artifact.sha256, outcome.outputSha256);
  assert.equal(outcome.sourceSha256, document.sha256);
  await application.store.deleteArtifact(outcome.artifact.id);
});

test('pages.page-boxes source-bound wrapper rejects forged outcome and revokes promoted artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-page-org-forged-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, sourcePath, artifact } = await createDocumentAndArtifact({
    root,
    sourceId: '11111111-1111-4111-9111-111111111111',
    sourcePdf: buildClassicPassivePdf({ pages: 1, width: 100, height: 100 }),
    artifactId: '22222222-2222-4222-8222-222222222222',
    operationId: '33333333-3333-4333-8333-333333333333',
  });
  const calls = { deleteArtifact: 0 };
  const wrapper = createProfessionalPageOrganizationDelivery({
    store: {
      async verifySource(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
      },
      getDocument(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
        return source;
      },
      getSourcePath(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source path.', 404);
        return sourcePath;
      },
      getArtifact(artifactId) {
        if (artifactId !== source.id && artifactId !== artifact.id) throw new HostError('ARTIFACT_NOT_FOUND', 'Missing retained artifact.', 404);
        return artifact;
      },
      async deleteArtifact(artifactId) {
        calls.deleteArtifact += 1;
        if (artifactId !== artifact.id) throw new HostError('ARTIFACT_NOT_FOUND', 'Missing retained artifact.', 404);
      },
    },
    services: {
      service: {
        async inspect() {
          return { pageCount: 1 };
        },
      },
      pdfkitMutations: {
        async mutate(_documentId, mutation, options) {
          return {
            artifact,
            sourceDigest: source.sha256,
            evidence: {
              sourceDigestReverified: true,
              nativeEffectsReopened: true,
              allPagesRendered: true,
            },
          };
        },
      },
    },
    deliver: async (_capabilityId, context) => {
      if (!context?.pdfkitMutations?.mutate) {
        throw new HostError('SERVICE_MISSING', 'PDFKit mutations authority is missing.', 500);
      }
      await context.pdfkitMutations.mutate(source.id, {}, { sourceSha256: source.sha256 });
      return ({
      capabilityId: 'pages.page-boxes',
      artifact: { ...artifact, id: '44444444-4444-4444-8444-444444444444' },
      serviceReceipt: { artifact },
      outputSha256: artifact.sha256,
      sourceSha256: source.sha256,
      documentId: source.id,
      page: 1,
      boxType: 'crop',
      box: { left: 0, bottom: 0, right: 90, top: 90 },
      pdf: await readFile(sourcePath),
      });
    },
    list: () => ['pages.page-boxes'],
  });
  const error = await wrapper.deliverSourceBound('pages.page-boxes', source.id, {
    sourceSha256: source.sha256,
    page: 1,
    boxType: 'crop',
    box: { left: 0, bottom: 0, right: 90, top: 90 },
  }).then(() => null, (value) => value);
  assert.equal(error?.code, 'PROFESSIONAL_PAGE_ORGANIZATION_RECEIPT_INVALID');
  assert.equal(calls.deleteArtifact, 1);

  calls.deleteArtifact = 0;
  const withoutPromotion = createProfessionalPageOrganizationDelivery({
    store: {
      async verifySource() {},
      getDocument: () => source,
      getSourcePath: () => sourcePath,
      getArtifact: () => artifact,
      async deleteArtifact() { calls.deleteArtifact += 1; },
    },
    services: {
      service: { inspect: async () => ({ pageCount: 1 }) },
      pdfkitMutations: { mutate: async () => assert.fail('mutation must not run') },
    },
    deliver: async () => ({
      artifact,
      outputSha256: artifact.sha256,
      sourceSha256: source.sha256,
    }),
    list: () => ['pages.page-boxes'],
  });
  const untrustedError = await withoutPromotion.deliverSourceBound('pages.page-boxes', source.id, {
    sourceSha256: source.sha256,
    page: 1,
    boxType: 'crop',
    box: { left: 0, bottom: 0, right: 90, top: 90 },
  }).then(() => null, (value) => value);
  assert.equal(untrustedError?.code, 'PROFESSIONAL_PAGE_ORGANIZATION_RECEIPT_INVALID');
  assert.equal(calls.deleteArtifact, 0);
});

test('pages.page-boxes source-bound wrapper propagates cancellation and revokes promoted artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-page-org-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, sourcePath, artifact } = await createDocumentAndArtifact({
    root,
    sourceId: '44444444-4444-4444-8444-444444444444',
    sourcePdf: buildClassicPassivePdf({ pages: 1, width: 100, height: 100 }),
    artifactId: '55555555-5555-4555-8555-555555555555',
    operationId: '66666666-6666-4666-8666-666666666666',
  });
  const calls = { deleteArtifact: 0 };
  const controller = new AbortController();
  const wrapper = createProfessionalPageOrganizationDelivery({
    store: {
      async verifySource(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
      },
      getDocument(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
        return source;
      },
      getSourcePath(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source path.', 404);
        return sourcePath;
      },
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
      service: {
        async inspect() {
          return { pageCount: 1 };
        },
      },
      pdfkitMutations: {
        async mutate() {
          return {
            artifact,
            sourceDigest: source.sha256,
            evidence: {
              sourceDigestReverified: true,
              nativeEffectsReopened: true,
              allPagesRendered: true,
            },
          };
        },
      },
    },
    deliver: async (_capabilityId, context) => {
      if (!context?.pdfkitMutations?.mutate) {
        throw new HostError('SERVICE_MISSING', 'PDFKit mutations authority is missing.', 500);
      }
      await context.pdfkitMutations.mutate(source.id, {}, { sourceSha256: source.sha256 });
      controller.abort();
      throw new HostError('JOB_CANCELLED', 'Professional page-organization delivery was cancelled.', 499);
    },
    list: () => ['pages.page-boxes'],
  });
  const error = await wrapper.deliverSourceBound('pages.page-boxes', source.id, {
    sourceSha256: source.sha256,
    page: 1,
    boxType: 'crop',
    box: { left: 0, bottom: 0, right: 90, top: 90 },
  }, { signal: controller.signal }).then(() => null, (value) => value);
  assert.equal(error?.code, 'JOB_CANCELLED');
  assert.equal(calls.deleteArtifact, 1);
});

test('pages.page-boxes source-bound wrapper revokes promoted artifact when source drifts after promotion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-page-org-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, sourcePath, artifact } = await createDocumentAndArtifact({
    root,
    sourceId: '77777777-7777-4777-8777-777777777777',
    sourcePdf: buildClassicPassivePdf({ pages: 1, width: 100, height: 100 }),
    artifactId: '88888888-8888-4888-8888-888888888888',
    operationId: '99999999-9999-4999-8999-999999999999',
  });
  const driftedSource = Object.freeze({ ...source, sha256: '0'.repeat(64), size: source.size + 1 });
  const calls = { getDocument: 0, deleteArtifact: 0 };
  const wrapper = createProfessionalPageOrganizationDelivery({
    store: {
      async verifySource(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
      },
      getDocument(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
        calls.getDocument += 1;
        return calls.getDocument > 1 ? driftedSource : source;
      },
      getSourcePath(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source path.', 404);
        return sourcePath;
      },
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
      service: {
        async inspect() {
          return { pageCount: 1 };
        },
      },
      pdfkitMutations: {
        async mutate() {
          return {
            artifact,
            sourceDigest: source.sha256,
            evidence: {
              sourceDigestReverified: true,
              nativeEffectsReopened: true,
              allPagesRendered: true,
            },
          };
        },
      },
    },
    deliver: async (_capabilityId, context) => {
      if (!context?.pdfkitMutations?.mutate) {
        throw new HostError('SERVICE_MISSING', 'PDFKit mutations authority is missing.', 500);
      }
      await context.pdfkitMutations.mutate(source.id, {}, { sourceSha256: source.sha256 });
      return {
        artifact,
        serviceReceipt: { artifact },
        outputSha256: artifact.sha256,
        sourceSha256: source.sha256,
        documentId: source.id,
      };
    },
    list: () => ['pages.page-boxes'],
  });
  const error = await wrapper.deliverSourceBound('pages.page-boxes', source.id, {
    sourceSha256: source.sha256,
    page: 1,
    boxType: 'crop',
    box: { left: 0, bottom: 0, right: 90, top: 90 },
  }).then(() => null, (value) => value);
  assert.equal(error?.code, 'SOURCE_INTEGRITY_FAILED');
  assert.equal(calls.deleteArtifact, 1);
  assert.equal(calls.getDocument > 1, true);
});

test('pages.page-boxes source-bound wrapper aggregates postflight and cleanup failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-page-org-aggregate-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { source, sourcePath, artifact } = await createDocumentAndArtifact({
    root,
    sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sourcePdf: buildClassicPassivePdf({ pages: 1, width: 100, height: 100 }),
    artifactId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  });
  let postflightError;
  let cleanupError;
  const wrapper = createProfessionalPageOrganizationDelivery({
    store: {
      async verifySource(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
      },
      getDocument(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source document.', 404);
        return source;
      },
      getSourcePath(documentId) {
        if (documentId !== source.id) throw new HostError('SOURCE_NOT_FOUND', 'Missing source path.', 404);
        return sourcePath;
      },
      getArtifact(artifactId) {
        if (artifactId !== artifact.id) throw new HostError('ARTIFACT_NOT_FOUND', 'Missing retained artifact.', 404);
        return artifact;
      },
      async deleteArtifact(artifactId) {
        if (artifactId === artifact.id) {
          cleanupError = new Error('injected cleanup failure');
          throw cleanupError;
        }
      },
    },
    services: {
      service: {
        async inspect() {
          return { pageCount: 1 };
        },
      },
      pdfkitMutations: {
        async mutate() {
          return {
            artifact,
            sourceDigest: source.sha256,
            evidence: {
              sourceDigestReverified: true,
              nativeEffectsReopened: true,
              allPagesRendered: true,
            },
          };
        },
      },
    },
    deliver: async (_capabilityId, context) => {
      if (!context?.pdfkitMutations?.mutate) {
        throw new HostError('SERVICE_MISSING', 'PDFKit mutations authority is missing.', 500);
      }
      await context.pdfkitMutations.mutate(source.id, {}, { sourceSha256: source.sha256 });
      postflightError = new HostError('POSTFLIGHT_FAILURE', 'Postflight validation failed.', 502);
      throw postflightError;
    },
    list: () => ['pages.page-boxes'],
  });
  const error = await wrapper.deliverSourceBound('pages.page-boxes', source.id, {
    sourceSha256: source.sha256,
    page: 1,
    boxType: 'crop',
    box: { left: 0, bottom: 0, right: 90, top: 90 },
  }).then(() => null, (value) => value);
  assert.equal(error instanceof HostError, true);
  assert.equal(error.code, 'PROFESSIONAL_PAGE_ORGANIZATION_CLEANUP_FAILED');
  assert.equal(error.cause instanceof AggregateError, true);
  assert.equal(error.cause.errors.includes(postflightError), true);
  assert.equal(error.cause.errors.includes(cleanupError), true);
});
