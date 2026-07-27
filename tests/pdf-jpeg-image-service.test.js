import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { PDF_JPEG_IMAGE_PROFILE, writePdfJpegImage, inspectPdfJpegImage } from '../scripts/host/pdf-jpeg-image-writer.mjs';
import { PdfJpegImageService } from '../scripts/host/pdf-jpeg-image-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==', 'base64');

async function fixture(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jpeg-image-service-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceBytes = makeMultiPagePdf(['one'], { cropBoxes: [[0, 0, 612, 792]] });
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const observed = { workspaces: [], cleaned: [], promoted: 0, deleted: [] };
  const controller = options.controller ?? new AbortController();
  const store = {
    getDocument: () => ({ id: documentId, sha256: sourceSha256, size: sourceBytes.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceSha256),
    createJobWorkspace: async () => { const workspace = await mkdtemp(join(root, 'job-')); await chmod(workspace, 0o700); observed.workspaces.push(workspace); return workspace; },
    cleanupJob: async (workspace) => { observed.cleaned.push(workspace); await rm(workspace, { recursive: true, force: true }); },
    promotePdfArtifact: async (_id, outputPath, promotion) => {
      observed.promoted += 1;
      const bytes = await readFile(outputPath);
      const artifact = { id: '22222222-2222-4222-8222-222222222222', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, displayName: promotion.displayName, operation: promotion.operation };
      if (options.cancelAfterPromotion) controller.abort(new Error('cancelled after promotion'));
      return artifact;
    },
    deleteArtifact: async (id) => { observed.deleted.push(id); },
  };
  const service = new PdfJpegImageService({ store, core: options.core });
  const request = { profile: PDF_JPEG_IMAGE_PROFILE, sourceSha256, page: 1, rect: { x: 10, y: 20, width: 100, height: 80 }, jpegBytes: Buffer.from(JPEG) };
  return { service, request, sourceSha256, observed, controller };
}

test('JPEG image service stages, re-inspects, promotes, and cleans a fresh resource', async (context) => {
  const setup = await fixture(context);
  const result = await setup.service.insert(documentId, setup.request, { sourceSha256: setup.sourceSha256 });
  assert.equal(result.kind, 'pdf-jpeg-image');
  assert.equal(result.artifact.sha256.length, 64);
  assert.equal(result.artifact.displayName, 'jpeg-image.pdf');
  assert.deepEqual(result.rect, { x: 10, y: 20, width: 100, height: 80 });
  assert.equal(setup.observed.promoted, 1);
  assert.equal(setup.observed.cleaned.length, 1);
  assert.equal(setup.observed.deleted.length, 0);
});

test('JPEG image service snapshots mutable requests and maps malformed input or stale sources', async (context) => {
  const setup = await fixture(context);
  const pending = setup.service.insert(documentId, setup.request, { sourceSha256: setup.sourceSha256 });
  setup.request.rect.x = 500; setup.request.jpegBytes[0] = 0;
  const result = await pending;
  assert.equal(result.rect.x, 10);
  await assert.rejects(setup.service.insert(documentId, { ...setup.request, jpegBytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }, { sourceSha256: setup.sourceSha256 }), { code: 'PDF_JPEG_IMAGE_OPTIONS_INVALID', status: 400 });
  await assert.rejects(setup.service.insert(documentId, setup.request, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  assert.equal(setup.observed.promoted, 1);
});

test('JPEG image service rejects independent proof or output tampering and leaves no artifact', async (context) => {
  const setup = await fixture(context, { core: { writePdfJpegImage, inspectPdfJpegImage: (...args) => ({ ...inspectPdfJpegImage(...args), resourceName: 'Im999' }) } });
  await assert.rejects(setup.service.insert(documentId, setup.request, { sourceSha256: setup.sourceSha256 }), { code: 'PDF_JPEG_IMAGE_OUTPUT_INVALID', status: 502 });
  assert.equal(setup.observed.promoted, 0);
  assert.equal(setup.observed.deleted.length, 0);
});

test('JPEG image service revokes a promoted artifact after cancellation and cleans private staging', async (context) => {
  const setup = await fixture(context, { cancelAfterPromotion: true });
  await assert.rejects(setup.service.insert(documentId, setup.request, { sourceSha256: setup.sourceSha256, signal: setup.controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
  assert.deepEqual(setup.observed.deleted, ['22222222-2222-4222-8222-222222222222']);
  assert.equal(setup.observed.cleaned.length, 1);
});
