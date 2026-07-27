import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeMultiPagePdf, makeTextPdf } from './pdf-fixture.js';
import { PDF_PRINTER_MARKS_PROFILE, inspectPdfPrinterMarks, writePdfPrinterMarks } from '../scripts/host/pdf-printer-marks-writer.mjs';
import { PdfPrinterMarksService } from '../scripts/host/pdf-printer-marks-service.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
async function fixture(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'printer-marks-service-')); context.after(() => rm(root, { recursive: true, force: true }));
  const bytes = options.sourceBytes ?? makeMultiPagePdf(['one', 'two'], { cropBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]], bleedBoxes: [[0, 0, 612, 792], [0, 0, 612, 792]], trimBoxes: [[18, 18, 594, 774], [18, 18, 594, 774]] }); const sha256 = createHash('sha256').update(bytes).digest('hex'); const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, bytes, { mode: 0o600 });
  const observed = { promoted: 0, cleaned: 0, deleted: [], workspaces: [] }; const controller = options.controller ?? new AbortController();
  const store = {
    getDocument: () => ({ id: documentId, sha256, size: bytes.length, displayName: 'source.pdf' }),
    getSourcePath: () => sourcePath,
    verifySource: async () => assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sha256),
    createJobWorkspace: async () => {
      const path = await mkdtemp(join(root, 'job-')); await chmod(path, 0o700); observed.workspaces.push(path); return path;
    },
    cleanupJob: async (path) => { observed.cleaned += 1; await rm(path, { recursive: true, force: true }); if (options.cleanupFailure) throw new Error('cleanup failed'); },
    promotePdfArtifact: async (_id, path, promotion) => {
      observed.promoted += 1; const output = await readFile(path); if (options.replaceOnPromotion) { output[output.length - 1] ^= 1; await chmod(path, 0o600); await writeFile(path, output); }
      if (options.cancelAfterPromotion) controller.abort(new Error('cancelled'));
      return { id: '22222222-2222-4222-8222-222222222222', sha256: createHash('sha256').update(output).digest('hex'), displayName: promotion.displayName, operation: promotion.operation };
    },
    deleteArtifact: async (id) => { observed.deleted.push(id); },
  };
  const core = options.core ?? { writePdfPrinterMarks, inspectPdfPrinterMarks }; const service = new PdfPrinterMarksService({ store, core }); const request = { profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256: sha256, pages: [1, 2] }; return { service, request, sha256, observed, controller };
}

test('printer-marks service stages, reinspects, promotes, and returns bounded provenance', async (context) => {
  const setup = await fixture(context); const result = await setup.service.create(documentId, setup.request, { sourceSha256: setup.sha256 }); assert.equal(result.pages.length, 2); assert.equal(result.artifact.displayName, 'printer-marks.pdf'); assert.equal(setup.observed.promoted, 1); assert.equal(setup.observed.cleaned, 1); assert.equal(result.limitations.some((text) => text.includes('trapping')), true);
});

test('printer-marks service maps stale, invalid, and unsupported sources', async (context) => {
  const setup = await fixture(context); await assert.rejects(setup.service.create(documentId, setup.request, { sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 }); await assert.rejects(setup.service.create(documentId, { ...setup.request, pages: [2, 1] }, { sourceSha256: setup.sha256 }), { code: 'PDF_PRINTER_MARKS_OPTIONS_INVALID', status: 400 }); const unsupported = await fixture(context, { sourceBytes: makeTextPdf() }); await assert.rejects(unsupported.service.create(documentId, unsupported.request, { sourceSha256: unsupported.sha256 }), { code: 'PDF_PRINTER_MARKS_SOURCE_UNSUPPORTED', status: 422 }); assert.equal(unsupported.observed.promoted, 0);
});

test('printer-marks service rejects getter, symbol, and non-enumerable request surfaces before work', async (context) => {
  const setup = await fixture(context); const getter = { profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256: setup.sha256, pages: [1] }; Object.defineProperty(getter, 'pages', { enumerable: true, get() { throw new Error('getter executed'); } }); await assert.rejects(setup.service.create(documentId, getter, { sourceSha256: setup.sha256 }), { code: 'PDF_PRINTER_MARKS_OPTIONS_INVALID', status: 400 });
  const symbol = { profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256: setup.sha256, pages: [1] }; symbol[Symbol('extra')] = true; await assert.rejects(setup.service.create(documentId, symbol, { sourceSha256: setup.sha256 }), { code: 'PDF_PRINTER_MARKS_OPTIONS_INVALID', status: 400 });
  const hidden = { profile: PDF_PRINTER_MARKS_PROFILE, sourceSha256: setup.sha256, pages: [1] }; Object.defineProperty(hidden, 'extra', { value: true, enumerable: false }); await assert.rejects(setup.service.create(documentId, hidden, { sourceSha256: setup.sha256 }), { code: 'PDF_PRINTER_MARKS_OPTIONS_INVALID', status: 400 });
});

test('printer-marks service snapshots mutable requests and revokes after cancellation', async (context) => {
  const setup = await fixture(context); const pending = setup.service.create(documentId, setup.request, { sourceSha256: setup.sha256 }); setup.request.pages[0] = 2; const result = await pending; assert.deepEqual(result.pages.map(({ page }) => page), [1, 2]); const cancelled = await fixture(context, { cancelAfterPromotion: true }); await assert.rejects(cancelled.service.create(documentId, cancelled.request, { sourceSha256: cancelled.sha256, signal: cancelled.controller.signal }), { code: 'JOB_CANCELLED', status: 499 }); assert.deepEqual(cancelled.observed.deleted, ['22222222-2222-4222-8222-222222222222']);
});

test('printer-marks service reports independent proof and cleanup failures', async (context) => {
  const tampered = await fixture(context, { core: { writePdfPrinterMarks, inspectPdfPrinterMarks: (...args) => ({ ...inspectPdfPrinterMarks(...args), pageCount: 99 }) } }); await assert.rejects(tampered.service.create(documentId, tampered.request, { sourceSha256: tampered.sha256 }), { code: 'PDF_PRINTER_MARKS_OUTPUT_INVALID', status: 502 }); const cleanup = await fixture(context, { cleanupFailure: true }); await assert.rejects(cleanup.service.create(documentId, cleanup.request, { sourceSha256: cleanup.sha256 }), { code: 'PDF_PRINTER_MARKS_CLEANUP_FAILED', status: 500 });
});

test('printer-marks service rejects output replacement during promotion', async (context) => {
  const setup = await fixture(context, { replaceOnPromotion: true });
  await assert.rejects(setup.service.create(documentId, setup.request, { sourceSha256: setup.sha256 }), { code: 'PDF_PRINTER_MARKS_OUTPUT_INVALID', status: 502 });
});
