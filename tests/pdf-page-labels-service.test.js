import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeMultiPagePdf, makeTextPdf } from './pdf-fixture.js';
import { PDF_PAGE_LABELS_PROFILE, inspectPdfPageLabels, writePdfPageLabels } from '../scripts/host/pdf-page-labels-writer.mjs';
import { PdfPageLabelsService } from '../scripts/host/pdf-page-labels-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
async function fixture(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'page-label-service-')); context.after(() => rm(root, { recursive: true, force: true }));
  const bytes = options.sourceBytes ?? makeMultiPagePdf(['one', 'two', 'three'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]] }); const sha256 = createHash('sha256').update(bytes).digest('hex'); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, bytes, { mode: 0o600 });
  const observed = { promoted: 0, cleaned: 0, deleted: [], workspaces: [] }; const controller = options.controller ?? new AbortController();
  const store = {
    getDocument: () => ({ id: documentId, sha256, size: bytes.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => assert.equal(
      createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sha256,
    ),
    createJobWorkspace: async () => {
      const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700);
      observed.workspaces.push(path); return path;
    },
    cleanupJob: async (path) => {
      observed.cleaned += 1; await rm(path, { recursive: true, force: true });
      if (options.cleanupFailure) throw new Error('cleanup failed');
    },
    promotePdfArtifact: async (_id, path, promotion) => {
      observed.promoted += 1; const output = await readFile(path);
      if (options.cancelAfterPromotion) controller.abort(new Error('cancelled'));
      return {
        id: '22222222-2222-4222-8222-222222222222',
        sha256: createHash('sha256').update(output).digest('hex'),
        displayName: promotion.displayName, operation: promotion.operation,
      };
    },
    deleteArtifact: async (id) => { observed.deleted.push(id); },
  };
  const core = options.core ?? { writePdfPageLabels, inspectPdfPageLabels }; const service = new PdfPageLabelsService({ store, core }); const request = { profile: PDF_PAGE_LABELS_PROFILE, sourceSha256: sha256, ranges: [{ start: 0, style: 'D', prefix: '§ ', startNumber: 1 }, { start: 2, style: 'R', prefix: 'Annex ', startNumber: 4 }] };
  return { service, request, sha256, observed, controller };
}

test('page-label service stages, independently reinspects, promotes, and returns non-ASCII labels', async (context) => {
  const setup = await fixture(context); const result = await setup.service.create(documentId, setup.request, { sourceSha256: setup.sha256 });
  assert.deepEqual(result.labels, ['§ 1', '§ 2', 'Annex IV']); assert.equal(result.artifact.displayName, 'page-labels.pdf'); assert.equal(setup.observed.promoted, 1); assert.equal(setup.observed.cleaned, 1);
});

test('page-label service maps stale and unsupported sources without promotion', async (context) => {
  const setup = await fixture(context); await assert.rejects(setup.service.create(documentId, setup.request, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  await assert.rejects(setup.service.create(documentId, { ...setup.request, ranges: [{ start: 0, style: 'D', startNumber: 0 }] }, { sourceSha256: setup.sha256 }), { code: 'PDF_PAGE_LABELS_OPTIONS_INVALID', status: 400 });
  const unsupported = await fixture(context, { sourceBytes: makeTextPdf() }); await assert.rejects(unsupported.service.create(documentId, unsupported.request, { sourceSha256: unsupported.sha256 }), { code: 'PDF_PAGE_LABELS_SOURCE_UNSUPPORTED', status: 422 }); assert.equal(unsupported.observed.promoted, 0);
});

test('page-label service snapshots mutable requests and rejects independent proof tampering', async (context) => {
  const setup = await fixture(context); const pending = setup.service.create(documentId, setup.request, { sourceSha256: setup.sha256 }); setup.request.ranges[0].prefix = 'mutated'; const result = await pending; assert.equal(result.ranges[0].prefix, '§ ');
  const tampered = await fixture(context, { core: { writePdfPageLabels, inspectPdfPageLabels: (...args) => ({ ...inspectPdfPageLabels(...args), pageCount: 99 }) } }); await assert.rejects(tampered.service.create(documentId, tampered.request, { sourceSha256: tampered.sha256 }), { code: 'PDF_PAGE_LABELS_OUTPUT_INVALID', status: 502 });
});

test('page-label service revokes promotion after cancellation and reports cleanup failure', async (context) => {
  const cancelled = await fixture(context, { cancelAfterPromotion: true }); await assert.rejects(cancelled.service.create(documentId, cancelled.request, { sourceSha256: cancelled.sha256, signal: cancelled.controller.signal }), { code: 'JOB_CANCELLED', status: 499 }); assert.deepEqual(cancelled.observed.deleted, ['22222222-2222-4222-8222-222222222222']);
  const cleanup = await fixture(context, { cleanupFailure: true }); await assert.rejects(cleanup.service.create(documentId, cleanup.request, { sourceSha256: cleanup.sha256 }), { code: 'PDF_PAGE_LABELS_CLEANUP_FAILED', status: 500 });
});
