import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';
import { PdfJpegImageReplacementInputBroker } from '../scripts/host/pdf-jpeg-image-replacement-input-broker.mjs';
import { PdfJpegImageReplacementService } from '../scripts/host/pdf-jpeg-image-replacement-service.mjs';
import { PDF_JPEG_IMAGE_REPLACEMENT_PROFILE } from '../scripts/host/pdf-jpeg-image-replacement-writer.mjs';
import { handlers } from '../scripts/host/professional-capability/content-editing.mjs';
import { runJpegImageReplacementCommand } from '../scripts/cli/commands/jpeg-image-replacement.mjs';

const DOCUMENT_ID = '123e4567-e89b-12d3-a456-426614174000';
const INPUT_ID = '223e4567-e89b-12d3-a456-426614174000';
const ARTIFACT_ID = '323e4567-e89b-12d3-a456-426614174000';
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==', 'base64');
const VALID_JPEG = Buffer.from(JPEG.toString('base64').replace('EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD', 'EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD'), 'base64');

function sourcePdf() {
  const content = 'q 80 0 0 60 10 20 cm /Im0 Do Q\n';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${VALID_JPEG.length} >>\nstream\n${VALID_JPEG.toString('latin1')}\nendstream`,
  ];
  const chunks = ['%PDF-1.4\n'];
  const offsets = [];
  bodies.forEach((body, index) => {
    offsets[index + 1] = Buffer.byteLength(chunks.join(''), 'latin1');
    chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xref = Buffer.byteLength(chunks.join(''), 'latin1');
  chunks.push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'latin1');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function installedPoppler(t) {
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 16 });
  const registry = new EngineRegistry({ runner });
  const probes = await Promise.allSettled(['pdfinfo', 'pdftotext', 'pdfimages', 'pdftocairo'].map((name) => registry.probe(name)));
  if (probes.some(({ status }) => status === 'rejected')) {
    t.skip('Required Poppler adapters are unavailable.');
    return null;
  }
  return { runner, poppler: new PopplerAdapter({ registry, runner }) };
}

async function replacementFixture(t) {
  const runtime = await installedPoppler(t);
  if (!runtime) return null;
  const root = await mkdtemp(join(tmpdir(), 'edit-images-claim-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = sourcePdf();
  const sourceSha256 = digest(source);
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, source, { mode: 0o600 });
  const replacement = Buffer.from(VALID_JPEG);
  replacement[replacement.length - 3] ^= 1;
  const inputSha256 = digest(replacement);
  const inputPath = join(root, 'replacement.jpg');
  await writeFile(inputPath, replacement, { mode: 0o600 });
  const artifactPath = join(root, 'artifact.pdf');
  const deleted = [];
  let promoted = null;
  const store = {
    getDocument: () => ({ id: DOCUMENT_ID, displayName: 'source.pdf', size: source.length, sha256: sourceSha256 }),
    getSourcePath: () => sourcePath,
    verifySource: async () => assert.equal(digest(await readFile(sourcePath)), sourceSha256),
    createJobWorkspace: async () => mkdtemp(join(root, 'job-')),
    cleanupJob: async (path) => rm(path, { recursive: true, force: true }),
    promotePdfArtifact: async (_id, path, options) => {
      const bytes = await readFile(path);
      assert.equal(digest(bytes), options.expectedSha256);
      await writeFile(artifactPath, bytes, { mode: 0o600 });
      promoted = {
        id: ARTIFACT_ID,
        documentId: DOCUMENT_ID,
        displayName: options.displayName,
        mediaType: 'application/pdf',
        size: bytes.length,
        sha256: options.expectedSha256,
        operation: JSON.parse(JSON.stringify(options.operation)),
        createdAt: new Date(0).toISOString(),
      };
      return promoted;
    },
    getArtifact: (id) => {
      assert.equal(id, ARTIFACT_ID);
      return { ...promoted, filePath: artifactPath };
    },
    deleteArtifact: async (id) => { deleted.push(id); },
  };
  const inputs = {
    getInput: (id) => {
      assert.equal(id, INPUT_ID);
      return { id: INPUT_ID, mediaType: 'image/jpeg', extension: '.jpg', size: replacement.length, sha256: inputSha256 };
    },
    getSourcePath: (id) => { assert.equal(id, INPUT_ID); return inputPath; },
    verifyInput: async (id) => { assert.equal(id, INPUT_ID); assert.equal(digest(await readFile(inputPath)), inputSha256); },
  };
  const service = new PdfJpegImageReplacementService({ store, poppler: runtime.poppler });
  const broker = new PdfJpegImageReplacementInputBroker({ inputs, service, store });
  const request = {
    profile: PDF_JPEG_IMAGE_REPLACEMENT_PROFILE,
    sourceSha256,
    inputId: INPUT_ID,
    inputSha256,
    page: 1,
    resourceName: 'Im0',
  };
  return { source, sourceSha256, replacement, inputSha256, inputPath, artifactPath, deleted, promoted, store, service, broker, request, poppler: runtime.poppler };
}

test('edit.images claim uses the source-bound private JPEG replacement authority', async (t) => {
  const fixture = await replacementFixture(t);
  if (!fixture) return;
  const privateInput = await readFile(fixture.inputPath);
  assert.equal(digest(privateInput), fixture.inputSha256);
  const result = await fixture.service.replace(DOCUMENT_ID, {
    profile: fixture.request.profile,
    sourceSha256: fixture.request.sourceSha256,
    page: fixture.request.page,
    resourceName: fixture.request.resourceName,
    jpegBytes: privateInput,
  }, { sourceSha256: fixture.sourceSha256 });
  assert.equal(result.kind, 'pdf-jpeg-image-replacement');
  assert.equal(result.sourceDigest, fixture.sourceSha256);
  assert.equal(result.artifact.documentId, DOCUMENT_ID);
  assert.equal(result.artifact.sha256, digest(await readFile(fixture.artifactPath)));
  assert.equal(result.artifact.operation.inputs[0].sha256, fixture.sourceSha256);
  assert.equal(result.replacementImage.sha256, fixture.inputSha256);
  assert.deepEqual(result.evidence, {
    sourcePrefixPreserved: true,
    contentPreserved: true,
    resourceIdentityPreserved: true,
    objectIdentityPreserved: true,
    outputDigestBound: true,
    sourceUnchanged: true,
    localOnly: true,
  });
  assert.deepEqual(result.artifact.operation.validation.validators, [
    'source-sha256', 'private-source-copy', 'raw-jpeg-image-replacement-proof', 'artifact-sha256',
    'pdfinfo-page-count', 'pdfinfo-page-boxes', 'pdftotext-equality', 'pdfimages-target-identity',
    'pdftocairo-render-change', 'pdftocairo-target-region',
  ]);
  assert.match(result.limitations.join('\n'), /direct baseline DeviceGray\/DeviceRGB DCTDecode image XObjects/u);
  assert.match(result.limitations.join('\n'), /Historical source bytes remain/u);
  assert.deepEqual(fixture.deleted, []);
});

test('edit.images claim revokes the exact retained artifact after cancellation', async () => {
  const deleted = [];
  const bytes = Buffer.from('private-jpeg-input');
  const inputSha256 = digest(bytes);
  const controller = new AbortController();
  const artifact = {
    id: ARTIFACT_ID,
    documentId: DOCUMENT_ID,
    displayName: 'jpeg-image-replacement.pdf',
    mediaType: 'application/pdf',
    size: 128,
    sha256: 'a'.repeat(64),
    operation: {},
    createdAt: new Date(0).toISOString(),
  };
  const root = await mkdtemp(join(tmpdir(), 'edit-images-claim-cancel-'));
  const inputPath = join(root, 'input.jpg');
  await writeFile(inputPath, bytes, { mode: 0o600 });
  // The broker must read a private asset before invoking its authority.
  const cancellingBroker = new PdfJpegImageReplacementInputBroker({
    inputs: {
      getInput: () => ({ id: INPUT_ID, mediaType: 'image/jpeg', extension: '.jpg', size: bytes.length, sha256: inputSha256 }),
      getSourcePath: () => inputPath,
      verifyInput: async () => {},
    },
    service: {
      replace: async () => {
        controller.abort(new Error('cancelled after promotion'));
        return { kind: 'pdf-jpeg-image-replacement', artifact };
      },
    },
    store: { getArtifact: () => artifact, deleteArtifact: async (id) => deleted.push(id) },
  });
  await assert.rejects(cancellingBroker.replace(DOCUMENT_ID, {
    profile: PDF_JPEG_IMAGE_REPLACEMENT_PROFILE,
    sourceSha256: 'b'.repeat(64),
    inputId: INPUT_ID,
    inputSha256,
    page: 1,
    resourceName: 'Im0',
  }, { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(deleted, [ARTIFACT_ID]);
  await rm(root, { recursive: true, force: true });
});

test('edit.images claim gate rejects synthetic handler output as production evidence', async () => {
  assert.equal(handlers['edit.images'], undefined);
});

test('replace-jpeg CLI receipt excludes private paths and bytes', async () => {
  const bytes = Buffer.from('abcdefghijkl');
  const input = { id: INPUT_ID, mediaType: 'image/jpeg', extension: '.jpg', size: bytes.length, sha256: digest(bytes) };
  const artifact = {
    id: ARTIFACT_ID,
    documentId: DOCUMENT_ID,
    mediaType: 'application/pdf',
    size: 128,
    sha256: 'd'.repeat(64),
    filePath: '/private/replacement.pdf',
  };
  const emitted = [];
  const application = {
    inputs: { createInput: async () => input, verifyInput: async () => {}, deleteInput: async () => {} },
    jpegImageReplacement: { replace: async () => ({ kind: 'pdf-jpeg-image-replacement', artifact: { ...artifact, filePath: artifact.filePath } }) },
    store: { getArtifact: () => artifact, deleteArtifact: async () => {} },
  };
  await runJpegImageReplacementCommand(application, { image: 'input.jpg', page: 1, resourceName: 'Im0', output: '/tmp/edit-images.pdf' }, { id: DOCUMENT_ID, sha256: 'b'.repeat(64) }, null, undefined, {
    cancelled() {},
    canonicalOutputTarget: async () => {},
    readLocalInputBytes: async () => ({ bytes, displayName: 'input.jpg' }),
    copyExclusive: async () => {},
    emit: async (_stdout, value) => emitted.push(value),
    fail(code, message) { throw Object.assign(new Error(message), { code }); },
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].artifact.filePath, undefined);
  assert.equal(emitted[0].artifact.output, 'edit-images.pdf');
  assert.equal(emitted[0].pdf, undefined);
});
