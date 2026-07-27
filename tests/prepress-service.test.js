import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { GhostscriptAdapter } from '../scripts/host/adapters/ghostscript.mjs';
import { ImageMagickAdapter } from '../scripts/host/adapters/imagemagick.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { GhostscriptIccProfileProvider } from '../scripts/host/icc-profile-provider.mjs';
import { PdfService } from '../scripts/host/pdf-service.mjs';
import { parseInkCoverage, PrepressService } from '../scripts/host/prepress-service.mjs';
import { makeMultiPagePdf, makeTextPdf } from './pdf-fixture.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const TIFF = Buffer.from([0x49,0x49,42,0,8,0,0,0,2,0,0,1,4,0,1,0,0,0,1,0,0,0,1,1,4,0,1,0,0,0,1,0,0,0,0,0,0,0]);
async function fixture(context, { pages = 1, ghostscriptImpl = null, imageMagickImpl = null, cleanupFails = false, limits = undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-prepress-test-')); let cleaned = 0; let verified = 0;
  const store = {
    getDocument: (id) => ({ id, sha256: createHash('sha256').update('%PDF-1.7').digest('hex') }), getSourcePath: () => join(root, 'source.pdf'),
    verifySource: async () => { verified += 1; return true; }, createJobWorkspace: async () => { const workspace = join(root, `job-${cleaned}`); await mkdir(workspace); return workspace; },
    cleanupJob: async (workspace) => { cleaned += 1; if (cleanupFails) throw new Error('cleanup failed'); await rm(workspace, { recursive: true, force: true }); },
  };
  await writeFile(join(root, 'source.pdf'), '%PDF-1.7');
  const ghostscript = ghostscriptImpl ?? { execute: async (operation, parameters) => {
    if (operation === 'analyzeInkCoverage') return { stdout: '0.10000 0.20000 0.30000 0.40000 CMYK OK\n' };
    if (operation === 'renderOverprintPreview') { await writeFile(parameters.output, PNG); return {}; }
    await writeFile(join(parameters.workspace, 'separation(Cyan).tif'), TIFF); return {};
  } };
  const imageMagick = imageMagickImpl ?? { execute: async (_operation, parameters) => { await writeFile(parameters.output, PNG); return {}; } };
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const pdfService = {
    inspect: async () => ({ pageCount: pages, encrypted: 'no', javascript: 'no' }),
    inspectPage: async () => ({ widthPoints: 612, heightPoints: 792 }),
    listFonts: async () => [{ name: 'Embedded', embedded: 'yes', unicode: 'yes' }],
    listImages: async () => [],
    inspectStructure: async (_id, options) => ({
      pageRange: { firstPage: 1, lastPage: options.lastPage, truncated: options.lastPage < pages },
      pageBoxes: Array.from({ length: options.lastPage }, (_, index) => ({
        page: index + 1, widthPoints: 612, heightPoints: 792,
        boxes: { mediaBox: { left: 0, bottom: 0, right: 612, top: 792 } },
      })),
      xmpMetadata: { present: false },
    }),
  };
  return { service: new PrepressService({ store, pdfService, ghostscript, imageMagick, limits }), state: () => ({ cleaned, verified }), sourcePath: join(root, 'source.pdf') };
}

test('strictly parses Ghostscript CMYK inckov rows', () => {
  assert.deepEqual(parseInkCoverage('0.1 0.2 0.3 0.4 CMYK OK\n')[0], { page: 1, cyan: 0.1, magenta: 0.2, yellow: 0.3, black: 0.4, totalInkPercent: 100 });
  assert.throws(() => parseInkCoverage('ghostscript banner'), { code: 'INK_COVERAGE_INVALID', status: 502 });
});

test('prepress reports are bounded, local-only, cleanup workspaces, and never disclose host paths', async (context) => {
  const { service, state } = await fixture(context);
  const ink = await service.analyzeInkCoverage('123e4567-e89b-42d3-a456-426614174000');
  assert.equal(ink.pages.length, 1); assert.equal(ink.evidence.localOnly, true);
  const separations = await service.renderSeparations('123e4567-e89b-42d3-a456-426614174000', { page: 1, dpi: 144 });
  const overprint = await service.renderOverprintPreview('123e4567-e89b-42d3-a456-426614174000', { page: 1, dpi: 144 });
  assert.equal(separations.images[0].format, 'image/png'); assert.equal(overprint.image.format, 'image/png');
  assert.equal(separations.effectiveDpi, 144); assert.equal(overprint.requestedDpi, 144);
  assert.equal(JSON.stringify({ ink, separations, overprint }).includes('/tmp/'), false);
  assert.equal(state().cleaned, 3); assert.equal(state().verified, 6);
});

test('prepress exposes fixed non-certifying print and archive review profiles', async (context) => {
  const { service, state } = await fixture(context);
  const print = await service.runPreflight('123e4567-e89b-42d3-a456-426614174000', { profile: 'print-review' });
  const archive = await service.runPreflight('123e4567-e89b-42d3-a456-426614174000', { profile: 'archive-review' });
  assert.equal(print.kind, 'preflight-review');
  assert.equal(print.authoritative, false);
  assert.equal(archive.checks.find(({ id }) => id === 'metadata.xmp').status, 'fail');
  assert.equal(JSON.stringify({ print, archive }).includes('/tmp/'), false);
  assert.equal(state().cleaned, 2);
  await assert.rejects(service.runPreflight('123e4567-e89b-42d3-a456-426614174000', { profile: 'custom' }), { code: 'INVALID_PREFLIGHT_PROFILE' });
});

test('prepress rejects page and DPI bounds and cancellation before engine execution', async (context) => {
  const { service } = await fixture(context);
  await assert.rejects(service.renderOverprintPreview('123e4567-e89b-42d3-a456-426614174000', { page: 2 }), { code: 'INVALID_PAGE' });
  await assert.rejects(service.renderSeparations('123e4567-e89b-42d3-a456-426614174000', { dpi: 301 }), { code: 'INVALID_DPI' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.analyzeInkCoverage('123e4567-e89b-42d3-a456-426614174000', { signal: controller.signal }), { code: 'JOB_CANCELLED', status: 499 });
});

test('prepress isolates native engines from the immutable source and rejects every unexpected output', async (context) => {
  const overwrite = await fixture(context, { ghostscriptImpl: { execute: async (_operation, parameters) => { await chmod(parameters.input, 0o600); await writeFile(parameters.input, 'damaged job copy'); return { stdout: '0.1 0.2 0.3 0.4 CMYK OK\n' }; } } });
  await overwrite.service.analyzeInkCoverage('doc');
  assert.equal(await readFile(overwrite.sourcePath, 'utf8'), '%PDF-1.7');

  const unexpected = await fixture(context, { ghostscriptImpl: { execute: async (_operation, parameters) => { await writeFile(join(parameters.workspace, 'unmatched.bin'), 'unexpected'); return { stdout: '0.1 0.2 0.3 0.4 CMYK OK\n' }; } } });
  await assert.rejects(unexpected.service.analyzeInkCoverage('doc'), { code: 'PREPRESS_WORKSPACE_INVALID', status: 502 });
});

test('prepress enforces active whole-workspace and whole-job limits and surfaces cleanup failure', async (context) => {
  const boundedLimits = { maxWorkspaceBytes: 64, maxTotalSeparationSourceBytes: 32, maxSeparationSourceBytes: 16, maxTotalPreviewBytes: 16, maxPreviewBytes: 8 };
  const oversized = await fixture(context, { limits: boundedLimits, ghostscriptImpl: { execute: async (_operation, parameters) => { await writeFile(join(parameters.workspace, 'large.bin'), Buffer.alloc(80)); return { stdout: '0.1 0.2 0.3 0.4 CMYK OK\n' }; } } });
  await assert.rejects(oversized.service.analyzeInkCoverage('doc'), { code: 'PREPRESS_WORKSPACE_LIMIT', status: 413 });

  const deadline = await fixture(context, { limits: { timeoutMs: 5 }, ghostscriptImpl: { execute: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { stdout: '0.1 0.2 0.3 0.4 CMYK OK\n' }; } } });
  await assert.rejects(deadline.service.analyzeInkCoverage('doc'), { code: 'PREPRESS_JOB_TIMEOUT', status: 504 });

  const cleanup = await fixture(context, { cleanupFails: true });
  await assert.rejects(cleanup.service.analyzeInkCoverage('doc'), { code: 'PREPRESS_CLEANUP_FAILED', status: 500 });
});

test('prepress lowers requested DPI to keep trusted-engine raster dimensions and pixels bounded', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-prepress-large-page-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = {
    getDocument: (id) => ({ id, sha256: createHash('sha256').update('%PDF-1.7').digest('hex') }), getSourcePath: () => join(root, 'source.pdf'),
    verifySource: async () => true, createJobWorkspace: async () => { const workspace = join(root, 'job'); await mkdir(workspace); return workspace; },
    cleanupJob: async (workspace) => rm(workspace, { recursive: true, force: true }),
  };
  await writeFile(join(root, 'source.pdf'), '%PDF-1.7');
  let engineDpi = null;
  const bounded = new PrepressService({
    store,
    pdfService: { inspect: async () => ({ pageCount: 1 }), inspectPage: async () => ({ widthPoints: 7200, heightPoints: 7200 }) },
    ghostscript: { execute: async (_operation, parameters) => { engineDpi = parameters.dpi; await writeFile(parameters.output, PNG); } },
    imageMagick: { execute: async () => {} },
  });
  const preview = await bounded.renderOverprintPreview('doc', { dpi: 300 });
  assert.equal(preview.requestedDpi, 300);
  assert.equal(preview.effectiveDpi, engineDpi);
  assert.ok(preview.effectiveDpi < 300 && preview.effectiveDpi >= 36);
});

test('CMYK artifact creation never promotes a leftover engine output after nonzero execution', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-prepress-leftover-')); context.after(() => rm(root, { recursive: true, force: true }));
  const sourceBytes = Buffer.from('%PDF-1.7\n'); const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, sourceBytes);
  let promoted = false; let cleaned = false;
  const store = {
    getDocument: (id) => ({ id, displayName: 'source.pdf', sha256: sourceSha256 }), getSourcePath: () => sourcePath,
    verifySource: async () => true, createJobWorkspace: async () => { const path = join(root, 'job'); await mkdir(path); return path; },
    cleanupJob: async (path) => { cleaned = true; await rm(path, { recursive: true, force: true }); },
    promotePdfArtifact: async () => { promoted = true; throw new Error('must not promote'); },
  };
  const profileBytes = Buffer.from('bounded profile fixture'); const profileSha256 = createHash('sha256').update(profileBytes).digest('hex');
  const service = new PrepressService({
    store,
    pdfService: {
      inspect: async () => ({ pageCount: 1, encrypted: 'no', javascript: 'no', form: 'none' }),
      inspectPage: async () => ({ widthPoints: 612, heightPoints: 792 }),
      inspectStructure: async () => ({ sourceDigest: sourceSha256, pageRange: { firstPage: 1, lastPage: 1, truncated: false }, pageBoxes: [{ page: 1, widthPoints: 612, heightPoints: 792, rotation: 0, boxes: { mediaBox: { left: 0, bottom: 0, right: 612, top: 792, width: 612, height: 792 }, cropBox: { left: 0, bottom: 0, right: 612, top: 792, width: 612, height: 792 } } }] }),
    },
    poppler: { execute: async () => { throw new Error('validation must not run'); } },
    ghostscript: {
      probe: async () => ({ name: 'Ghostscript', version: 'test' }),
      execute: async (_operation, parameters) => { await writeFile(parameters.output, makeTextPdf('LEFTOVER')); throw Object.assign(new Error('engine failed'), { code: 'ENGINE_PROCESS_FAILED' }); },
    },
    imageMagick: { execute: async () => {} },
    iccProfileProvider: { stageDefaultCmyk: async (workspace) => { const path = join(workspace, 'default-cmyk.icc'); await writeFile(path, profileBytes); return { path, engine: { name: 'Ghostscript', version: 'test' }, descriptor: { id: 'ghostscript-default-cmyk', description: 'fixture', colorSpace: 'CMYK', sha256: profileSha256, size: profileBytes.length } }; } },
  });
  await assert.rejects(service.convertToCmyk('doc'), { code: 'ENGINE_PROCESS_FAILED' });
  assert.equal(promoted, false); assert.equal(cleaned, true);
});

test('installed local Ghostscript produces one-page ink coverage evidence when fixed engines are present', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/gs', '/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/magick'].map((path) => access(path))); } catch { context.skip('Fixed local Ghostscript, Poppler, or ImageMagick engines are unavailable.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'pdf-prepress-native-')); const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose());
  const registry = new EngineRegistry(); const pdfService = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const service = new PrepressService({ store, pdfService, ghostscript: new GhostscriptAdapter({ registry }), imageMagick: new ImageMagickAdapter({ registry }) });
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('LOCAL PREPRESS')]), displayName: 'prepress.pdf' });
  const report = await service.analyzeInkCoverage(document.id);
  const preflight = await service.runPreflight(document.id, { profile: 'print-review' });
  const separations = await service.renderSeparations(document.id, { page: 1, dpi: 72 });
  const overprint = await service.renderOverprintPreview(document.id, { page: 1, dpi: 72 });
  assert.equal(report.pages.length, 1); assert.equal(report.document.sha256, document.sha256);
  assert.equal(preflight.document.sha256, document.sha256); assert.equal(preflight.authoritative, false);
  assert.ok(separations.images.length >= 4); assert.equal(overprint.image.format, 'image/png');
  assert.equal(await store.verifySource(document.id), true);
});

test('installed engines create deterministic source-bound CMYK and N-up artifacts with non-certifying validation', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/gs', '/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftocairo'].map((path) => access(path))); } catch { context.skip('Fixed local Ghostscript and Poppler engines are unavailable.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'pdf-prepress-artifact-')); const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose());
  const registry = new EngineRegistry(); const poppler = new PopplerAdapter({ registry });
  const pdfService = new PdfService({ store, registry, adapter: poppler });
  const service = new PrepressService({
    store, pdfService, poppler, ghostscript: new GhostscriptAdapter({ registry }),
    imageMagick: new ImageMagickAdapter({ registry }),
    iccProfileProvider: new GhostscriptIccProfileProvider({ registry }),
  });
  const document = await store.createDocument({
    stream: Readable.from([makeMultiPagePdf(['PAGE ONE', 'PAGE TWO', 'PAGE THREE'])]), displayName: 'production.pdf',
  });
  const [firstCmyk, secondCmyk] = [await service.convertToCmyk(document.id), await service.convertToCmyk(document.id)];
  assert.equal(firstCmyk.kind, 'icc-cmyk-artifact');
  assert.equal(firstCmyk.profile.colorSpace, 'CMYK');
  assert.equal(firstCmyk.receipt.outputIntentEmbeddedOrValidated, false);
  assert.equal(firstCmyk.receipt.pdfXValidated, false);
  assert.equal(firstCmyk.artifact.sha256, secondCmyk.artifact.sha256);
  assert.equal(firstCmyk.artifact.operation.validation.textSha256, secondCmyk.artifact.operation.validation.textSha256);

  const [firstNup, secondNup] = [
    await service.createImposition(document.id, { layout: '2x1', marks: false }),
    await service.createImposition(document.id, { layout: '2x1', marks: false }),
  ];
  assert.equal(firstNup.kind, 'imposition-artifact');
  assert.equal(firstNup.layout.sheetCount, 2);
  assert.deepEqual(firstNup.layout.sheet, { widthPoints: 1224, heightPoints: 792 });
  assert.equal(firstNup.receipt.unconditionalVectorPreservationClaim, false);
  assert.equal(firstNup.artifact.sha256, secondNup.artifact.sha256);
  await assert.rejects(service.createImposition(document.id, { layout: '2x1', marks: true }), { code: 'PRINTER_MARKS_UNSUPPORTED', status: 422 });

  const production = await service.runProductionValidation(document.id);
  assert.equal(production.kind, 'print-production-validation');
  assert.equal(production.authoritative, false);
  assert.equal(production.certification, false);
  assert.equal(production.checks.find(({ id }) => id === 'standards.pdf-x').status, 'not-checked');
  assert.match(production.reportSha256, /^[0-9a-f]{64}$/u);

  const rotated = await store.createDocument({
    stream: Readable.from([makeMultiPagePdf(['NORMAL', 'ROTATED'], { rotations: [0, 90] })]), displayName: 'mixed.pdf',
  });
  await assert.rejects(service.createImposition(rotated.id, { layout: '2x1', marks: false }), { code: 'IMPOSITION_GEOMETRY_UNSUPPORTED', status: 422 });
  assert.equal(await store.verifySource(document.id), true);
});
