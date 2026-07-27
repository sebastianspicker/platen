import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { PdfJpegImageReplacementService } from '../scripts/host/pdf-jpeg-image-replacement-service.mjs';
import { HostError } from '../scripts/host/host-error.mjs';

test('replacement service verifies source, promotes artifact, and cleans workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jpeg-replacement-service-')); const sourceBytes = Buffer.from('%PDF-1.4\nfixture-source-012345678901234567890123456789'); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, sourceBytes, { mode: 0o600 }); const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex'); const artifactPath = join(root, 'artifact.pdf'); const calls = []; const documentId = '123e4567-e89b-12d3-a456-426614174000';
  const store = { getDocument: () => ({ id: documentId, size: sourceBytes.length, sha256: sourceSha256 }), getSourcePath: () => sourcePath, verifySource: async () => calls.push('verify'), createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-')); calls.push('workspace'); return path; }, cleanupJob: async (path) => { calls.push('cleanup'); await rm(path, { recursive: true, force: true }); }, promotePdfArtifact: async (_id, path, options) => { calls.push('promote'); await writeFile(artifactPath, await readFile(path)); return { id: 'artifact', sha256: options.expectedSha256 }; }, deleteArtifact: async () => calls.push('delete') };
  const output = Buffer.concat([sourceBytes, Buffer.from('\nrevision')]); const proof = { profile: 'local-pdf-jpeg-image-replacement-v1', sourceSha256, page: 1, resourceName: 'Im0', targetReference: '5 0 R', replacementImage: { width: 1, height: 1, components: 3, bytes: 1, sha256: 'a'.repeat(64) }, invocation: { contentReference: '4 0 R', ctm: [1, 0, 0, 1, 0, 0] } }; const core = { writePdfJpegImageReplacement: () => ({ bytes: output, proof }), inspectPdfJpegImageReplacement: () => proof }; const service = new PdfJpegImageReplacementService({ store, core });
  const result = await service.replace(documentId, { profile: proof.profile, sourceSha256, page: 1, resourceName: 'Im0', jpegBytes: Buffer.from('jpeg') }, { sourceSha256 }); assert.equal(result.kind, 'pdf-jpeg-image-replacement'); assert.deepEqual(await readFile(artifactPath), output); assert.ok(calls.includes('verify')); assert.ok(calls.includes('cleanup')); await rm(root, { recursive: true, force: true });
});
test('replacement service rejects accessor-backed request objects before source access', async () => { const store = { getDocument() { throw new Error('source access should not occur'); }, getSourcePath() {}, verifySource() {}, createJobWorkspace() {}, cleanupJob() {}, promotePdfArtifact() {}, deleteArtifact() {} }; const service = new PdfJpegImageReplacementService({ store }); const request = {}; Object.defineProperty(request, 'jpegBytes', { enumerable: true, get() { throw new Error('getter'); } }); Object.defineProperties(request, { profile: { enumerable: true, value: 'local-pdf-jpeg-image-replacement-v1' }, sourceSha256: { enumerable: true, value: 'a'.repeat(64) }, page: { enumerable: true, value: 1 }, resourceName: { enumerable: true, value: 'Im0' } }); await assert.rejects(service.replace('doc', request, { sourceSha256: 'a'.repeat(64) }), { code: 'PDF_JPEG_IMAGE_REPLACEMENT_OPTIONS_INVALID' }); });

function hostileFixture({ writer, inspector = null, workspaceEntry = null, cleanupFailure = false, cancelOnVerify = null, cancelController = null, mutateSourceOnVerify = false } = {}) {
  const sourceBytes = Buffer.from('%PDF-1.4\nfixture-source-012345678901234567890123456789'); const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex'); const documentId = '123e4567-e89b-12d3-a456-426614174000'; const output = Buffer.concat([sourceBytes, Buffer.from('\nrevision')]); const proof = { profile: 'local-pdf-jpeg-image-replacement-v1', sourceSha256, page: 1, resourceName: 'Im0', targetReference: '5 0 R', replacementImage: { width: 1, height: 1, components: 3, bytes: 1, sha256: 'a'.repeat(64) }, invocation: { contentReference: '4 0 R', ctm: [1, 0, 0, 1, 0, 0] } };
  const rootPromise = mkdtemp(join(tmpdir(), 'jpeg-replacement-hostile-'));
  return rootPromise.then(async (root) => {
    const sourcePath = join(root, 'source.pdf');
    await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
    let verifies = 0; const deleted = []; const promoted = [];
    const store = {
      getDocument: () => ({ id: documentId, size: sourceBytes.length, sha256: sourceSha256 }),
      getSourcePath: () => sourcePath,
      verifySource: async () => {
        verifies += 1;
        if (cancelOnVerify === verifies) cancelController.abort(new Error('cancelled'));
        if (mutateSourceOnVerify && verifies === 2) {
          await writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('tampered')]));
          throw new HostError('SOURCE_INTEGRITY_FAILED', 'source changed', 500);
        }
      },
      createJobWorkspace: async () => {
        const path = await mkdtemp(join(root, 'job-'));
        if (workspaceEntry === 'file') await writeFile(join(path, 'unexpected'), 'x');
        if (workspaceEntry === 'symlink') await symlink(sourcePath, join(path, 'unexpected'));
        return path;
      },
      cleanupJob: async (path) => { await rm(path, { recursive: true, force: true }); if (cleanupFailure) throw new Error('cleanup failed'); },
      promotePdfArtifact: async (_id, path, options) => {
        const bytes = await readFile(path); const sha256 = createHash('sha256').update(bytes).digest('hex'); promoted.push({ path, bytes });
        return { id: '223e4567-e89b-12d3-a456-426614174000', documentId, displayName: options.displayName, mediaType: 'application/pdf', size: bytes.length, sha256, operation: options.operation, createdAt: new Date(0).toISOString() };
      },
      deleteArtifact: async (id) => { deleted.push(id); },
    };
    const core = {
      writePdfJpegImageReplacement: () => ({ bytes: writer?.bytes ?? output, proof: writer?.proof ?? proof }),
      inspectPdfJpegImageReplacement: () => inspector ?? proof,
    };
    return { root, sourceSha256, documentId, proof, output, store, core, deleted, promoted };
  });
}

async function requestFor(sourceSha256) { return { profile: 'local-pdf-jpeg-image-replacement-v1', sourceSha256, page: 1, resourceName: 'Im0', jpegBytes: Buffer.from('jpeg') }; }

test('replacement service rejects forged writer bytes and reinspection proof mismatches before promotion', async () => {
  const forged = await hostileFixture({ writer: { bytes: Buffer.from('%PDF-1.4\nforged'), proof: null } }); const service = new PdfJpegImageReplacementService({ store: forged.store, core: forged.core }); await assert.rejects(service.replace(forged.documentId, await requestFor(forged.sourceSha256), { sourceSha256: forged.sourceSha256 }), { code: 'PDF_JPEG_IMAGE_REPLACEMENT_OUTPUT_INVALID' }); assert.equal(forged.promoted.length, 0); await rm(forged.root, { recursive: true, force: true });
  const mismatch = await hostileFixture({ inspector: { ...forged.proof, page: 2 } }); const serviceMismatch = new PdfJpegImageReplacementService({ store: mismatch.store, core: mismatch.core }); await assert.rejects(serviceMismatch.replace(mismatch.documentId, await requestFor(mismatch.sourceSha256), { sourceSha256: mismatch.sourceSha256 }), { code: 'PDF_JPEG_IMAGE_REPLACEMENT_OUTPUT_INVALID' }); assert.equal(mismatch.promoted.length, 0); await rm(mismatch.root, { recursive: true, force: true });
});

test('replacement service rejects source replacement, unexpected workspace files, and cancellation before promotion', async () => {
  for (const workspaceEntry of ['file', 'symlink']) { const fixture = await hostileFixture({ workspaceEntry }); const service = new PdfJpegImageReplacementService({ store: fixture.store, core: fixture.core }); await assert.rejects(service.replace(fixture.documentId, await requestFor(fixture.sourceSha256), { sourceSha256: fixture.sourceSha256 }), { code: 'PDF_JPEG_IMAGE_REPLACEMENT_WORKSPACE_INVALID' }); assert.equal(fixture.promoted.length, 0); await rm(fixture.root, { recursive: true, force: true }); }
  const changed = await hostileFixture({ mutateSourceOnVerify: true }); const changedService = new PdfJpegImageReplacementService({ store: changed.store, core: changed.core }); await assert.rejects(changedService.replace(changed.documentId, await requestFor(changed.sourceSha256), { sourceSha256: changed.sourceSha256 }), { code: 'SOURCE_INTEGRITY_FAILED' }); assert.equal(changed.promoted.length, 0); await rm(changed.root, { recursive: true, force: true });
  const controller = new AbortController(); const cancelled = await hostileFixture({ cancelOnVerify: 2, cancelController: controller }); const cancelledService = new PdfJpegImageReplacementService({ store: cancelled.store, core: cancelled.core }); await assert.rejects(cancelledService.replace(cancelled.documentId, await requestFor(cancelled.sourceSha256), { sourceSha256: cancelled.sourceSha256, signal: controller.signal }), { code: 'JOB_CANCELLED' }); assert.equal(cancelled.promoted.length, 0); await rm(cancelled.root, { recursive: true, force: true });
});

test('replacement service revokes a promoted artifact when private cleanup fails', async () => {
  const fixture = await hostileFixture({ cleanupFailure: true }); const service = new PdfJpegImageReplacementService({ store: fixture.store, core: fixture.core }); await assert.rejects(service.replace(fixture.documentId, await requestFor(fixture.sourceSha256), { sourceSha256: fixture.sourceSha256 }), { code: 'PDF_JPEG_IMAGE_REPLACEMENT_CLEANUP_FAILED' }); assert.equal(fixture.promoted.length, 1); assert.deepEqual(fixture.deleted, ['223e4567-e89b-12d3-a456-426614174000']); await rm(fixture.root, { recursive: true, force: true }); });
