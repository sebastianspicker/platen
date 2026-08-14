import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeMultiPagePdf } from './pdf-fixture.js';
import { PDF_PAGE_HEADER_FOOTER_PROFILE } from '../scripts/host/pdf-page-header-footer-contract.mjs';
import { PdfPageHeaderFooterService } from '../scripts/host/pdf-page-header-footer-service.mjs';
const documentId = '11111111-1111-4111-8111-111111111111';
function request(bytes) { return { profile: PDF_PAGE_HEADER_FOOTER_PROFILE, sourceSha256: createHash('sha256').update(bytes).digest('hex'), pages: [1, 2], header: 'TOP', footerPrefix: 'Page ' }; }
async function setup(t, hooks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'header-footer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = makeMultiPagePdf(['one', 'two'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]] });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const source = join(root, 'source.pdf');
  await writeFile(source, bytes, { mode: 0o600 });
  const store = {
    getDocument: () => ({ id: documentId, sha256, size: bytes.length }),
    getSourcePath: () => source,
    verifySource: hooks.verifySource ?? (async () => {}),
    createJobWorkspace: async () => {
      const workspace = await mkdtemp(join(root, 'job-'));
      await chmod(workspace, 0o700);
      return workspace;
    },
    cleanupJob: hooks.cleanupJob ?? (async (workspace) => rm(workspace, { recursive: true, force: true })),
    promotePdfArtifact: hooks.promotePdfArtifact ?? (async (_id, path, promotion) => {
      const output = await readFile(path);
      return {
        id: '22222222-2222-4222-8222-222222222222',
        documentId,
        displayName: promotion.displayName,
        mediaType: 'application/pdf',
        size: output.length,
        sha256: createHash('sha256').update(output).digest('hex'),
        createdAt: new Date().toISOString(),
        operation: promotion.operation,
      };
    }),
    deleteArtifact: hooks.deleteArtifact ?? (async () => {}),
  };
  return { bytes, sha256, store };
}
test('header/footer service returns a private-text-free retained artifact receipt', async (t) => { const state = await setup(t); const receipt = await new PdfPageHeaderFooterService({ store: state.store }).create(documentId, request(state.bytes), { sourceSha256: state.sha256 }); assert.deepEqual(Object.keys(receipt).sort(), ['artifact', 'evidence', 'kind', 'limitations', 'pages']); assert.equal(JSON.stringify(receipt).includes('TOP'), false); assert.equal(JSON.stringify(receipt).includes(state.sha256), false); assert.deepEqual(receipt.pages, [{ page: 1, applied: true }, { page: 2, applied: true }]); });
test('header/footer service maps cancellation and cleanup failure', async (t) => { const state = await setup(t); const controller = new AbortController(); controller.abort(); await assert.rejects(new PdfPageHeaderFooterService({ store: state.store }).create(documentId, request(state.bytes), { sourceSha256: state.sha256, signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 }); const dirty = await setup(t, { cleanupJob: async () => { throw new Error('cleanup'); } }); await assert.rejects(new PdfPageHeaderFooterService({ store: dirty.store }).create(documentId, request(dirty.bytes), { sourceSha256: dirty.sha256 }), { code: 'PDF_PAGE_HEADER_FOOTER_CLEANUP_FAILED', status: 500 }); });
