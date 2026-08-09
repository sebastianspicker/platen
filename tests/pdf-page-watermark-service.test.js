import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { PDF_PAGE_WATERMARK_PROFILE } from '../scripts/host/pdf-page-watermark-contract.mjs';
import { inspectPdfPageWatermark, writePdfPageWatermark } from '../scripts/host/pdf-page-watermark-writer.mjs';
import { PdfPageWatermarkService } from '../scripts/host/pdf-page-watermark-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
function request(bytes, pages = [1]) { return { profile: PDF_PAGE_WATERMARK_PROFILE, sourceSha256: createHash('sha256').update(bytes).digest('hex'), pages, text: 'CONFIDENTIAL' }; }
async function setup(t, hooks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'page-watermark-service-')); t.after(() => rm(root, { recursive: true, force: true })); const bytes = makeMultiPagePdf(['one', 'two'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]] }); const sha = createHash('sha256').update(bytes).digest('hex'); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, bytes, { mode: 0o600 });
  const store = { getDocument: () => ({ id: documentId, sha256: sha, size: bytes.length }), getSourcePath: () => sourcePath, verifySource: hooks.verifySource ?? (async () => {}), createJobWorkspace: async () => { const workspace = await mkdtemp(join(root, 'job-')); await chmod(workspace, 0o700); return workspace; }, cleanupJob: hooks.cleanupJob ?? (async (workspace) => rm(workspace, { recursive: true, force: true })), promotePdfArtifact: hooks.promotePdfArtifact ?? (async (_id, path, promotion) => { const output = await readFile(path); return { id: '22222222-2222-4222-8222-222222222222', documentId, displayName: promotion.displayName, mediaType: 'application/pdf', size: output.length, sha256: createHash('sha256').update(output).digest('hex') }; }), deleteArtifact: hooks.deleteArtifact ?? (async () => {}) };
  return { root, bytes, sha, sourcePath, store, request: request(bytes, [1, 2]) };
}

test('watermark service stages, independently proves, promotes, and cleans without private receipt fields', async (t) => {
  const setupValue = await setup(t); let promoted = 0; const original = setupValue.store.promotePdfArtifact; setupValue.store.promotePdfArtifact = async (...args) => { promoted += 1; return original(...args); };
  const result = await new PdfPageWatermarkService({ store: setupValue.store }).create(documentId, setupValue.request, { sourceSha256: setupValue.sha });
  assert.equal(result.kind, 'pdf-page-watermark'); assert.deepEqual(result.pages, [{ page: 1, applied: true }, { page: 2, applied: true }]); assert.equal(promoted, 1); assert.equal(JSON.stringify(result).includes('CONFIDENTIAL'), false); assert.equal(JSON.stringify(result).includes(setupValue.sha), false); assert.equal(JSON.stringify(result).includes('input.pdf'), false);
});

test('watermark service rejects proof lies and output tampering', async (t) => {
  const s = await setup(t); const lie = new PdfPageWatermarkService({ store: s.store, core: { writePdfPageWatermark: (source, req) => { const output = writePdfPageWatermark(source, req); return { ...output, proof: { ...output.proof, pageCount: 99 } }; }, inspectPdfPageWatermark } });
  await assert.rejects(lie.create(documentId, s.request, { sourceSha256: s.sha }), { code: 'PDF_PAGE_WATERMARK_OUTPUT_INVALID', status: 502 });
  const tamper = new PdfPageWatermarkService({ store: s.store, core: { writePdfPageWatermark: (source, req) => { const output = writePdfPageWatermark(source, req); const bytes = Buffer.from(output.bytes); bytes[bytes.length - 20] ^= 1; return { ...output, bytes }; }, inspectPdfPageWatermark } });
  await assert.rejects(tamper.create(documentId, s.request, { sourceSha256: s.sha }), { code: 'PDF_PAGE_WATERMARK_OUTPUT_INVALID', status: 502 });
});

test('watermark service revokes after cancellation and aggregates cleanup failures', async (t) => {
  const controller = new AbortController(); let deleted = 0; const s = await setup(t, { promotePdfArtifact: async (_id, path, promotion) => { const output = await readFile(path); controller.abort(); return { id: '22222222-2222-4222-8222-222222222222', documentId, displayName: promotion.displayName, mediaType: 'application/pdf', size: output.length, sha256: createHash('sha256').update(output).digest('hex') }; }, deleteArtifact: async () => { deleted += 1; } });
  await assert.rejects(new PdfPageWatermarkService({ store: s.store }).create(documentId, s.request, { sourceSha256: s.sha, signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 }); assert.equal(deleted, 1);
  const cleanup = await setup(t, { cleanupJob: async () => { throw new Error('cleanup'); } }); await assert.rejects(new PdfPageWatermarkService({ store: cleanup.store }).create(documentId, cleanup.request, { sourceSha256: cleanup.sha }), { code: 'PDF_PAGE_WATERMARK_CLEANUP_FAILED', status: 500 });
});

test('watermark service fails closed when source revalidation detects drift', async (t) => {
  let calls = 0; const s = await setup(t, { verifySource: async () => { calls += 1; if (calls > 1) throw new Error('source drift'); } });
  await assert.rejects(new PdfPageWatermarkService({ store: s.store }).create(documentId, s.request, { sourceSha256: s.sha }), { code: 'PDF_PAGE_WATERMARK_FAILED', status: 502 });
});
