import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { PDF_PAGE_BACKGROUND_PROFILE } from '../scripts/host/pdf-page-background-contract.mjs';
import { inspectPdfPageBackground, writePdfPageBackground } from '../scripts/host/pdf-page-background-writer.mjs';
import { PdfPageBackgroundService } from '../scripts/host/pdf-page-background-service.mjs';
import { validatePageBackgroundResult } from '../src/core/pdf-page-background-contract.js';

const documentId = '11111111-1111-4111-8111-111111111111';
test('page-background service stages, independently reinspects, promotes, and cleans', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'page-background-service-'));
context.after(() => rm(root, { recursive: true, force: true }));
  const bytes = makeMultiPagePdf(['one', 'two'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]] });
const sha256 = createHash('sha256').update(bytes).digest('hex');
const sourcePath = join(root, 'source.pdf');
await writeFile(sourcePath, bytes, { mode: 0o600 });
let promoted = 0;
let cleaned = 0;
  const store = { getDocument: () => ({ id: documentId, sha256, size: bytes.length }), getSourcePath: () => sourcePath, verifySource: async () => {}, createJobWorkspace: async () => { const path = await mkdtemp(join(root, 'job-'));
await chmod(path, 0o700);
return path;
}, cleanupJob: async (path) => { cleaned += 1;
await rm(path, { recursive: true, force: true });
}, promotePdfArtifact: async (_id, path, promotion) => { promoted += 1;
const output = await readFile(path);
return { id: '22222222-2222-4222-8222-222222222222', documentId, displayName: promotion.displayName, mediaType: 'application/pdf', size: output.length, sha256: createHash('sha256').update(output).digest('hex'), operation: promotion.operation, createdAt: new Date().toISOString() };
}, deleteArtifact: async () => {} };
  const service = new PdfPageBackgroundService({ store });
const request = { profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: sha256, pages: [1, 2], color: { r: 0.2, g: 0.3, b: 0.4 } };
const result = await service.create(documentId, request, { sourceSha256: sha256 });
  assert.equal(result.pages.length, 2);
assert.equal(result.artifact.displayName, 'page-background.pdf');
assert.equal(promoted, 1);
assert.equal(cleaned, 1);
  const browserResult = validatePageBackgroundResult(JSON.parse(JSON.stringify(result)), { documentId, sourceSha256: sha256, request: { pages: [1, 2], color: { r: 0.2, g: 0.3, b: 0.4 } } });
assert.equal(browserResult.kind, 'pdf-solid-page-background');
assert.throws(() => { browserResult.pages[0].page = 9;
}, TypeError);
});

test('page-background service revokes a promoted artifact after cancellation', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'page-background-cancel-'));
context.after(() => rm(root, { recursive: true, force: true }));
const bytes = makeMultiPagePdf(['one'], { cropBoxes: [[0, 0, 612, 792]] });
const sha = createHash('sha256').update(bytes).digest('hex');
const path = join(root, 'source.pdf');
await writeFile(path, bytes, { mode: 0o600 });
const controller = new AbortController();
let deleted = 0;
const store = { getDocument: () => ({ id: documentId, sha256: sha, size: bytes.length }), getSourcePath: () => path, verifySource: async () => {}, createJobWorkspace: async () => { const workspace = await mkdtemp(join(root, 'job-'));
await chmod(workspace, 0o700);
return workspace;
}, cleanupJob: async (workspace) => rm(workspace, { recursive: true, force: true }), promotePdfArtifact: async (_id, outputPath, promotion) => { const output = await readFile(outputPath);
controller.abort(new Error('cancelled'));
return { id: '22222222-2222-4222-8222-222222222222', documentId, displayName: promotion.displayName, mediaType: 'application/pdf', size: output.length, sha256: createHash('sha256').update(output).digest('hex'), operation: promotion.operation, createdAt: new Date().toISOString() };
}, deleteArtifact: async () => { deleted += 1;
} };
const service = new PdfPageBackgroundService({ store });
const request = { profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: sha, pages: [1], color: { r: 0, g: 0, b: 0 } };
await assert.rejects(service.create(documentId, request, { sourceSha256: sha, signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
assert.equal(deleted, 1);
});

test('page-background service maps stale and unsupported sources', async () => {
  const source = makeMultiPagePdf(['one'], { cropBoxes: [[0, 0, 612, 792]] });
const sha256 = createHash('sha256').update(source).digest('hex');
const service = new PdfPageBackgroundService({ store: { getDocument: () => ({ sha256, size: source.length }), getSourcePath: () => '', verifySource: async () => {}, createJobWorkspace: async () => '', cleanupJob: async () => {}, promotePdfArtifact: async () => ({}), deleteArtifact: async () => {} } });
const request = { profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: sha256, pages: [1], color: { r: 0, g: 0, b: 0 } };
await assert.rejects(service.create(documentId, request, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
});

test('page-background service rejects injected proof lies and output tampering', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'page-background-proof-'));
context.after(() => rm(root, { recursive: true, force: true }));
const bytes = makeMultiPagePdf(['one'], { cropBoxes: [[0, 0, 612, 792]] });
const sha = createHash('sha256').update(bytes).digest('hex');
const sourcePath = join(root, 'source.pdf');
await writeFile(sourcePath, bytes, { mode: 0o600 });
const base = { getDocument: () => ({ id: documentId, sha256: sha, size: bytes.length }), getSourcePath: () => sourcePath, verifySource: async () => {}, createJobWorkspace: async () => { const workspace = await mkdtemp(join(root, 'job-'));
await chmod(workspace, 0o700);
return workspace;
}, cleanupJob: async (workspace) => rm(workspace, { recursive: true, force: true }), promotePdfArtifact: async () => { throw new Error('must not promote');
}, deleteArtifact: async () => {} };
const request = { profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: sha, pages: [1], color: { r: 0, g: 0, b: 0 } };
  const lie = new PdfPageBackgroundService({ store: base, core: { writePdfPageBackground: (source, req) => { const output = writePdfPageBackground(source, req);
return { ...output, proof: { ...output.proof, pageCount: 99 } };
}, inspectPdfPageBackground } });
await assert.rejects(lie.create(documentId, request, { sourceSha256: sha }), { code: 'PDF_PAGE_BACKGROUND_OUTPUT_INVALID', status: 502 });
  const tamper = new PdfPageBackgroundService({ store: base, core: { writePdfPageBackground: (source, req) => { const output = writePdfPageBackground(source, req);
const bytesOut = Buffer.from(output.bytes);
bytesOut[bytesOut.length - 20] ^= 1;
return { ...output, bytes: bytesOut };
}, inspectPdfPageBackground } });
await assert.rejects(tamper.create(documentId, request, { sourceSha256: sha }), { code: 'PDF_PAGE_BACKGROUND_OUTPUT_INVALID', status: 502 });
});

test('page-background service fails closed on source revalidation, workspace entries, and cleanup errors', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'page-background-hostile-'));
context.after(() => rm(root, { recursive: true, force: true }));
const bytes = makeMultiPagePdf(['one'], { cropBoxes: [[0, 0, 612, 792]] });
const sha = createHash('sha256').update(bytes).digest('hex');
const sourcePath = join(root, 'source.pdf');
await writeFile(sourcePath, bytes, { mode: 0o600 });
const request = { profile: PDF_PAGE_BACKGROUND_PROFILE, sourceSha256: sha, pages: [1], color: { r: 0, g: 0, b: 0 } };
const base = { getDocument: () => ({ id: documentId, sha256: sha, size: bytes.length }), getSourcePath: () => sourcePath, verifySource: async () => {}, createJobWorkspace: async () => { const workspace = await mkdtemp(join(root, 'job-'));
await chmod(workspace, 0o700);
await writeFile(join(workspace, 'unexpected'), 'x');
return workspace;
}, cleanupJob: async (workspace) => rm(workspace, { recursive: true, force: true }), promotePdfArtifact: async () => { throw new Error('must not promote');
}, deleteArtifact: async () => {} };
const workspaceFailure = new PdfPageBackgroundService({ store: base });
await assert.rejects(workspaceFailure.create(documentId, request, { sourceSha256: sha }), { code: 'PDF_PAGE_BACKGROUND_WORKSPACE_INVALID', status: 502 });
let verifyCalls = 0;
const revalidation = new PdfPageBackgroundService({ store: {
  ...base,
  createJobWorkspace: async () => {
    const workspace = await mkdtemp(join(root, 'revalidation-'));
    await chmod(workspace, 0o700);
    return workspace;
  },
  verifySource: async () => {
    verifyCalls += 1;
    if (verifyCalls > 1) {
      await writeFile(sourcePath, Buffer.concat([bytes, Buffer.from('drift')]), { mode: 0o600 });
      throw new Error('source identity changed');
    }
  },
} });
await assert.rejects(revalidation.create(documentId, request, { sourceSha256: sha }), { code: 'PDF_PAGE_BACKGROUND_FAILED', status: 502 });
  const cleanup = new PdfPageBackgroundService({ store: { ...base, createJobWorkspace: async () => { const workspace = await mkdtemp(join(root, 'cleanup-'));
await chmod(workspace, 0o700);
return workspace;
}, cleanupJob: async () => { throw new Error('cleanup');
} } });
await assert.rejects(cleanup.create(documentId, request, { sourceSha256: sha }), { code: 'PDF_PAGE_BACKGROUND_CLEANUP_FAILED', status: 500 });
});
