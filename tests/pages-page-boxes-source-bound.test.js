import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { before, test } from 'node:test';
import { handlers } from '../scripts/host/professional-capability/page-organization.mjs';
import { PdfKitMutationService } from '../scripts/host/pdfkit-mutation-service.mjs';
import { PdfService } from '../scripts/host/pdf-service.mjs';
import * as support from './host-pdfkit-test-support.js';

const {
  canRunIntegration,
  chmod,
  createProcessLimiter,
  DocumentStore,
  EngineRegistry,
  mkdtemp,
  makeMultiPagePdf,
  packagePath,
  PDFKitAdapter,
  PopplerAdapter,
  projectPath,
  stagePdfKitHelper,
  spawnSync,
  verifyStagedPdfKitHelper,
} = support;

const CROP_BOX = Object.freeze({ left: 20, bottom: 20, right: 580, top: 760 });
const CROP_RECT = Object.freeze({ x: 20, y: 20, width: 560, height: 740 });
const BLEED_BOX = Object.freeze({ left: 10, bottom: 10, right: 602, top: 782 });
const BLEED_RECT = Object.freeze({ x: 10, y: 10, width: 592, height: 772 });
const CAN_RUN = canRunIntegration();

async function productionContext(t) {
  if (!CAN_RUN) {
    t.skip('Installed PDFKit helper integration tooling is unavailable.');
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-page-boxes-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);

  const staged = await stagePdfKitHelper({ root: projectPath, sessionRoot: root });
  assert.equal(staged.available, true);

  const source = makeMultiPagePdf(['First', 'Second'], {
    cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]],
    bleedBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]],
    trimBoxes: [[20, 20, 592, 772], [20, 20, 592, 772]],
  });

  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 });
  const registry = new EngineRegistry({ runner });
  const poppler = new PopplerAdapter({ registry, runner });
  const store = await new DocumentStore({ root: join(root, 'store') }).initialize();
  const service = new PdfService({ store, registry, adapter: poppler });
  const pdfkitMutations = new PdfKitMutationService({
    store,
    poppler,
    adapter: new PDFKitAdapter({
      executable: staged.executable,
      expectedSha256: staged.sha256,
      verifyExecutable: verifyStagedPdfKitHelper,
      runner,
    }),
  });

  const sourceDocument = await store.createDocument({
    stream: Readable.from([source]),
    displayName: 'source.pdf',
  });

  return {
    service,
    store,
    pdfkitMutations,
    sourceDocument,
  };
}

function baseContext(context) {
  return {
    service: context.service,
    pdfkitMutations: context.pdfkitMutations,
    store: context.store,
    documentId: context.sourceDocument.id,
    sourceSha256: context.sourceDocument.sha256,
  };
}

function trackedStore(store, deleted) {
  return {
    getDocument: store.getDocument.bind(store),
    verifySource: store.verifySource.bind(store),
    getArtifact: store.getArtifact.bind(store),
    deleteArtifact: async (artifactId) => {
      deleted.push(artifactId);
      return store.deleteArtifact(artifactId);
    },
  };
}

before(() => {
  if (!CAN_RUN) return;
  const build = spawnSync('swift', ['build', '-c', 'release', '--package-path', packagePath], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
});

test('pages.page-boxes publishes source-bound CropBox artifacts with exact operation provenance', async (t) => {
  const context = await productionContext(t);
  const result = await handlers['pages.page-boxes']({
    ...baseContext(context),
    page: 2,
    boxType: 'crop',
    box: { ...CROP_BOX },
  });
  assert.equal(result.method, 'source-bound-pdfkit-crop-box');
  assert.equal(result.operation.validation.croppedPage, 2);
  assert.deepEqual({ ...result.operation.validation.persistentCropBox }, CROP_RECT);
  assert.deepEqual({ ...result.artifact.operation.validation.persistentCropBox }, CROP_RECT);
});

test('pages.page-boxes publishes source-bound BleedBox artifacts with exact operation provenance', async (t) => {
  const context = await productionContext(t);
  const result = await handlers['pages.page-boxes']({
    ...baseContext(context),
    page: 1,
    boxType: 'bleed',
    box: { ...BLEED_BOX },
  });
  assert.equal(result.method, 'source-bound-pdfkit-bleed-box');
  assert.equal(result.operation.validation.bleedBoxPage, 1);
  assert.deepEqual({ ...result.operation.validation.persistentBleedBox }, BLEED_RECT);
});

test('pages.page-boxes rejects CropBox and BleedBox requests outside PDFKit service geometry authority', async (t) => {
  const context = await productionContext(t);
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      page: 1,
      boxType: 'crop',
      box: { left: -10, bottom: 0, right: 50, top: 100 },
    }),
    { code: 'INVALID_PDFKIT_MUTATION', status: 400 },
  );
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      page: 1,
      boxType: 'bleed',
      box: { left: 30, bottom: 30, right: 580, top: 740 },
    }),
    { code: 'INVALID_PDFKIT_MUTATION', status: 400 },
  );
});

test('pages.page-boxes rejects box property shape drift (extra, symbol, inherited, accessor)', async (t) => {
  const context = await productionContext(t);
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      page: 1,
      boxType: 'crop',
      box: { ...CROP_BOX, extra: true },
    }),
    { code: 'PAGES_CONTEXT_INVALID', status: 400 },
  );
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      page: 1,
      boxType: 'crop',
      box: { ...CROP_BOX, [Symbol('extra')]: true },
    }),
    { code: 'PAGES_CONTEXT_INVALID', status: 400 },
  );
  const inheritedBox = Object.create(CROP_BOX);
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      page: 1,
      boxType: 'crop',
      box: inheritedBox,
    }),
    { code: 'PAGES_CONTEXT_INVALID', status: 400 },
  );
  const accessorBox = {};
  Object.defineProperty(accessorBox, 'left', { enumerable: true, get: () => CROP_BOX.left });
  Object.defineProperty(accessorBox, 'bottom', { enumerable: true, value: CROP_BOX.bottom });
  Object.defineProperty(accessorBox, 'right', { enumerable: true, value: CROP_BOX.right });
  Object.defineProperty(accessorBox, 'top', { enumerable: true, value: CROP_BOX.top });
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      page: 1,
      boxType: 'crop',
      box: accessorBox,
    }),
    { code: 'PAGES_CONTEXT_INVALID', status: 400 },
  );
});

test('pages.page-boxes rejects tampered output, forged digest, and forged validator proofs', async (t) => {
  const context = await productionContext(t);
  const tamperedDeleted = [];
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      store: trackedStore(context.store, tamperedDeleted),
      pdfkitMutations: {
        mutate: async (documentId, mutation, options) => {
          const result = await context.pdfkitMutations.mutate(documentId, mutation, options);
          const artifact = context.store.getArtifact(result.artifact.id);
          await writeFile(artifact.filePath, Buffer.from('%PDF-1.7\ntampered\n%%EOF\n', 'ascii'));
          return result;
        },
      },
      page: 1,
      boxType: 'crop',
      box: { ...CROP_BOX },
    }),
    { code: 'PAGES_OUTPUT_INVALID', status: 502 },
  );

  const forgedDigestDeleted = [];
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      store: trackedStore(context.store, forgedDigestDeleted),
      pdfkitMutations: {
        mutate: async (documentId, mutation, options) => {
          const result = await context.pdfkitMutations.mutate(documentId, mutation, options);
          return { ...result, sourceDigest: '0'.repeat(64) };
        },
      },
      page: 1,
      boxType: 'crop',
      box: { ...CROP_BOX },
    }),
    { code: 'PAGES_OUTPUT_INVALID', status: 502 },
  );

  const forgedValidationDeleted = [];
  const forgedValidationStore = trackedStore(context.store, forgedValidationDeleted);
  forgedValidationStore.getArtifact = (artifactId) => {
    const artifact = context.store.getArtifact(artifactId);
    return {
      ...artifact,
      operation: {
        ...artifact.operation,
        validation: {
          ...(artifact.operation.validation ?? {}),
          validators: ['source-sha256', 'pdfkit-effect-reopen'],
        },
      },
    };
  };
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      store: forgedValidationStore,
      page: 1,
      boxType: 'crop',
      box: { ...CROP_BOX },
    }),
    { code: 'PAGES_OUTPUT_INVALID', status: 502 },
  );
});

test('pages.page-boxes rejects source-drift and does not revoke when no retained artifact exists', async (t) => {
  const context = await productionContext(t);
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      store: context.store,
      sourceSha256: '0'.repeat(64),
      page: 1,
      boxType: 'crop',
      box: { ...CROP_BOX },
    }),
    { code: 'SOURCE_VERSION_MISMATCH', status: 409 },
  );
});

test('pages.page-boxes preserves unsupported-source failures from the PDFKit service without cleanup', async (t) => {
  const context = await productionContext(t);
  const deleted = [];
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      store: trackedStore(context.store, deleted),
      pdfkitMutations: {
        mutate: async () => {
          const error = new Error('Signed source is blocked in mutation service.');
          error.code = 'PDFKIT_SIGNED_SOURCE_UNSUPPORTED';
          error.status = 422;
          throw error;
        },
      },
      page: 1,
      boxType: 'crop',
      box: { ...CROP_BOX },
    }),
    { code: 'PDFKIT_SIGNED_SOURCE_UNSUPPORTED', status: 422 },
  );
  assert.equal(deleted.length, 0);
});

test('pages.page-boxes propagates cancellation before publication', async (t) => {
  const context = await productionContext(t);
  const controller = new AbortController();
  const deleted = [];
  const cancelledService = {
    mutate: async (documentId, mutation, options) => {
      const result = await context.pdfkitMutations.mutate(documentId, mutation, options);
      controller.abort();
      return result;
    },
  };
  await assert.rejects(
    handlers['pages.page-boxes']({
      ...baseContext(context),
      signal: controller.signal,
      store: trackedStore(context.store, deleted),
      pdfkitMutations: cancelledService,
      page: 2,
      boxType: 'bleed',
      box: { ...BLEED_BOX },
    }),
    (error) => error.code === 'JOB_CANCELLED' && error.status === 499,
  );
  const sourceBytes = await readFile(context.store.getSourcePath(context.sourceDocument.id));
  assert.equal(sourceBytes.length > 0, true);
});
