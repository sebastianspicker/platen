import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ImageMagickAdapter } from '../scripts/host/adapters/imagemagick.mjs';
import { buildRasterMutationArgs, buildRasterRegionAnalysisArgs, RasterMutationAdapter } from '../scripts/host/adapters/raster-mutation.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { RasterMutationService } from '../scripts/host/raster-mutation-service.mjs';
import { normalizedRegion, parsePageCount } from '../scripts/host/raster-mutation-contract.mjs';
import { jobSignal } from '../scripts/host/raster-mutation-helpers.mjs';
import { encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';
import { makeMultiPagePdf, makeTextPdf } from './pdf-fixture.js';

test('raster mutation argv is fixed, bounded, and does not permit filename text expansion', () => {
  const args = buildRasterMutationArgs({ input: '/source.png', output: '/jobs/a/out.png', workspace: '/jobs/a', rotateDegrees: 90, crop: { x: 0, y: 1, width: 20, height: 30 }, overlay: { placement: 'header', text: 'LOCAL', pointSize: 12 } });
  assert.equal(args.includes('-rotate'), true); assert.equal(args.includes('-crop'), true); assert.equal(args.includes('-annotate'), true);
  assert.throws(() => buildRasterMutationArgs({ input: '/source.png', output: '/jobs/a/out.png', workspace: '/jobs/a', overlay: { placement: 'header', text: '@unsafe', pointSize: 12 } }), /must not start with @/);
  assert.throws(() => buildRasterMutationArgs({ input: '/source.png', output: '/tmp/out.png', workspace: '/jobs/a' }), /inside workspace/);
  assert.deepEqual(buildRasterRegionAnalysisArgs({
    input: '/jobs/a/out.png', workspace: '/jobs/a', region: { x: 2, y: 3, width: 20, height: 30 },
  }), ['/jobs/a/out.png', '-alpha', 'off', '-crop', '20x30+2+3', '+repage', '-colorspace', 'sRGB', '-format', '%[fx:maxima]', 'info:']);
  assert.throws(() => buildRasterRegionAnalysisArgs({ input: '/source.png', workspace: '/jobs/a', region: { x: 0, y: 0, width: 2, height: 2 } }), /inside workspace/);
});

test('raster mutation helpers retain strict page, region, and cancellation boundaries', () => {
  assert.equal(parsePageCount('Pages: 50\n'), 50);
  assert.throws(() => parsePageCount('Pages: 51\n'), { code: 'INVALID_ENGINE_OUTPUT', status: 502 });
  assert.deepEqual(normalizedRegion({ x: 0, y: 0, width: 1, height: 1 }, 'region'), { x: 0, y: 0, width: 1, height: 1 });
  assert.throws(() => normalizedRegion({ x: 0, y: 0, width: 1.01, height: 1 }, 'region'), { code: 'INVALID_PARAMETER', status: 400 });
  const controller = new AbortController(); const job = jobSignal(controller.signal);
  controller.abort(new Error('cancelled by caller'));
  assert.equal(job.signal.aborted, true);
  job.dispose();
});

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'platen-raster-mutation-')); const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose());
  const registry = new EngineRegistry();
  return { store, service: new RasterMutationService({ store, poppler: new PopplerAdapter({ registry }), imageMagick: new ImageMagickAdapter({ registry }), raster: new RasterMutationAdapter({ registry }) }) };
}

function verifiedRedaction(source, parameters) {
  return {
    profile: 'verified-raster-burn-v2',
    sourceSha256: source.sha256,
    ...parameters,
  };
}

test('verified raster redaction rejects ambiguous or non-boolean target shapes before engine work', async (context) => {
  const { store, service } = await fixture(context);
  const source = await store.createDocument({
    stream: Readable.from([makeTextPdf('STRICT REDACTION SHAPE')]), displayName: 'shape.pdf',
  });
  const region = { x: 0.05, y: 0.03, width: 0.8, height: 0.14 };
  for (const redaction of [
    { page: 1, fullPage: 'false', removedText: 'STRICT REDACTION SHAPE' },
    { page: 1, fullPage: 1, removedText: 'STRICT REDACTION SHAPE' },
    { page: 1, fullPage: null, removedText: 'STRICT REDACTION SHAPE' },
    { page: 1, fullPage: false, removedText: 'STRICT REDACTION SHAPE' },
    { page: 1, fullPage: true, region, removedText: 'STRICT REDACTION SHAPE' },
    { page: 1, region, removedText: 'STRICT REDACTION SHAPE', extra: true },
    { page: 1, region: { ...region, extra: true }, removedText: 'STRICT REDACTION SHAPE' },
  ]) {
    await assert.rejects(service.redact(source.id, verifiedRedaction(source, {
      pages: [1], redactions: [redaction],
    })), { code: 'INVALID_REDACTIONS', status: 400 });
  }
  assert.equal(await store.verifySource(source.id), true);
});

test('verified raster redaction keeps all source-side native operations on the immutable staged copy across a store-path swap', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-raster-source-race-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const original = makeTextPdf('IMMUTABLE RASTER SOURCE');
  const source = await store.createDocument({ stream: Readable.from([original]), displayName: 'source.pdf' });
  const writableSource = store.getSourcePath(source.id);
  const backup = `${writableSource}.before-swap`;
  const sourcePng = encodeRgbaPng({ width: 1, height: 1, pixels: Buffer.from([255, 255, 255, 255]) });
  const blackPng = encodeRgbaPng({ width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) });
  const sourceCalls = [];
  let stagedSourcePath = null;
  let swapped = false;
  const assertStagedSource = async (operation, input) => {
    assert.notEqual(input, writableSource, `${operation} must not reopen the writable store path`);
    if (stagedSourcePath === null) stagedSourcePath = input;
    assert.equal(input, stagedSourcePath, `${operation} must use the one staged source path`);
    assert.deepEqual(await readFile(input), original, `${operation} must read the staged original bytes`);
    sourceCalls.push(operation);
  };
  const poppler = {
    async execute(operation, parameters) {
      const isSource = parameters.input !== undefined && (stagedSourcePath === null || parameters.input === stagedSourcePath);
      if (isSource) {
        await assertStagedSource(operation, parameters.input);
        if (operation === 'inspect') {
          await rename(writableSource, backup);
          await writeFile(writableSource, makeTextPdf('HOSTILE REPLACEMENT'));
          swapped = true;
          return { stdout: 'Pages: 1\nEncrypted: no\nTagged: no\nForm: none\nJavaScript: no\nPage size: 612 x 792 pts\n' };
        }
        if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n` };
        if (operation === 'inspectPage') return { stdout: 'Page 1 size: 612 x 792 pts\nPage 1 rot: 0\nPage 1 MediaBox: 0 0 612 792\nPage 1 CropBox: 0 0 612 792\n' };
        if (operation === 'extractTextRegion') return { stdout: 'IMMUTABLE RASTER SOURCE\n' };
        if (operation === 'renderPagePng') {
          await writeFile(`${parameters.outputPrefix}.png`, sourcePng);
          await rm(writableSource);
          await rename(backup, writableSource);
          return { stdout: '' };
        }
        assert.fail(`unexpected source operation: ${operation}`);
      }
      if (operation === 'inspect') return { stdout: 'Pages: 1\nEncrypted: no\nTagged: no\nForm: none\nJavaScript: no\nPage size: 612 x 792 pts\n' };
      if (operation === 'renderPagePng') { await writeFile(`${parameters.outputPrefix}.png`, blackPng); return { stdout: '' }; }
      if (operation === 'listAttachments') return { stdout: '0 embedded files\n' };
      if (operation === 'inspectUrls') return { stdout: 'Page Type URL\n' };
      if (operation === 'verifySignatures') return { stdout: `File '${parameters.input}' does not contain any signatures\n` };
      if (operation === 'extractText') return { stdout: '' };
      assert.fail(`unexpected output operation: ${operation}`);
    },
  };
  const imageMagick = { async execute(operation, parameters) {
    assert.equal(operation, 'convertRasterToPdf');
    await writeFile(parameters.output, makeTextPdf(''));
    return { stdout: '' };
  } };
  const raster = {
    async mutate({ input, output }) { assert.deepEqual(await readFile(input), sourcePng); await writeFile(output, blackPng); return { stdout: '' }; },
    async analyzeRegion() { return { stdout: '0' }; },
  };
  const service = new RasterMutationService({ store, poppler, imageMagick, raster });
  const artifact = await service.redact(source.id, verifiedRedaction(source, {
    redactions: [{ page: 1, fullPage: true, removedText: 'IMMUTABLE RASTER SOURCE' }],
  }));
  assert.equal(swapped, true);
  assert.deepEqual(sourceCalls, ['inspect', 'verifySignatures', 'inspectPage', 'extractTextRegion', 'renderPagePng']);
  assert.equal(artifact.operation.type, 'raster-redact');
  assert.equal(await store.verifySource(source.id), true);
});

test('installed raster engine derives a flattened redaction with text and render evidence', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/pdfunite', '/opt/homebrew/bin/magick'].map((path) => access(path))); } catch { context.skip('Fixed Poppler and ImageMagick tools are unavailable.'); return; }
  const { store, service } = await fixture(context);
  const source = await store.createDocument({ stream: Readable.from([makeTextPdf('TOP SECRET RASTER MUTATION')]), displayName: 'secret.pdf' });
  const artifact = await service.redact(source.id, verifiedRedaction(source, {
    redactions: [{ page: 1, fullPage: true, removedText: 'TOP SECRET RASTER MUTATION' }],
  }));
  assert.equal(artifact.operation.type, 'raster-redact'); assert.equal(artifact.operation.validation.rasterized, true);
  for (const validator of [
    'source-sha256', 'poppler-region-text-binding',
    'png-target-opaque-black', 'png-nontarget-pixel-equality', 'poppler-post-pdf-black-region',
    'pdftotext-empty-raster', 'pdfinfo-passive-raster',
    'pdfdetach-no-attachments', 'pdfinfo-no-object-urls',
  ]) assert.equal(artifact.operation.validation.validators.includes(validator), true);
  assert.equal(artifact.operation.validation.redactionCount, 1);
  assert.equal(artifact.operation.validation.profile, 'verified-raster-burn-v2');
  assert.deepEqual(artifact.operation.validation.verifiedPages, [1]);
  assert.equal(artifact.operation.validation.sensitiveTextRetained, false);
  assert.equal(artifact.operation.validation.extractableTextPresent, false);
  assert.equal(artifact.operation.validation.signaturesPresent, false);
  assert.equal(artifact.operation.parameters.textEvidence, 'validated-transiently-not-retained');
  assert.equal(JSON.stringify(artifact).includes('TOP SECRET RASTER MUTATION'), false);
  const bytes = await readFile(store.getArtifact(artifact.id).filePath); assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(await store.verifySource(source.id), true);
});

test('installed raster engine applies the bounded rotate, crop, resize, overlay, and flatten paths', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/magick'].map((path) => access(path))); } catch { context.skip('Fixed Poppler and ImageMagick tools are unavailable.'); return; }
  const { store, service } = await fixture(context);
  const source = await store.createDocument({ stream: Readable.from([makeTextPdf('RASTER PATHS')]), displayName: 'paths.pdf' });
  const artifacts = await Promise.all([
    service.rotatePages(source.id, { pages: [1], degrees: 90 }),
    service.cropPages(source.id, { pages: [1], region: { x: 0, y: 0, width: 0.75, height: 0.75 } }),
    service.resizePages(source.id, { pages: [1], widthPoints: 320, heightPoints: 480 }),
    service.addOverlayText(source.id, { pages: [1], overlay: { placement: 'bates', text: 'BATES-{page}' } }),
    service.flatten(source.id),
  ]);
  assert.deepEqual(artifacts.map((artifact) => artifact.operation.type), ['raster-rotate', 'raster-crop', 'raster-resize', 'raster-overlay', 'raster-flatten']);
  assert.equal(artifacts.every((artifact) => artifact.operation.validation.validators.includes('poppler-render-png')), true);
});

test('installed raster redaction strips active source structure across a multi-page output', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/pdfunite', '/opt/homebrew/bin/pdfdetach', '/opt/homebrew/bin/magick'].map((path) => access(path))); } catch { context.skip('Fixed Poppler and ImageMagick tools are unavailable.'); return; }
  const { store, service } = await fixture(context);
  const source = await store.createDocument({
    stream: Readable.from([makeMultiPagePdf(['REMOVE PAGE ONE', 'VISIBLE PAGE TWO'], {
      attachment: { name: 'private.txt', content: 'hidden source attachment' },
      outlines: [{ title: 'Private outline', page: 2 }],
    })]),
    displayName: 'structured-secret.pdf',
  });
  const artifact = await service.redact(source.id, verifiedRedaction(source, {
    pages: [1], redactions: [{ page: 1, fullPage: true, removedText: 'REMOVE PAGE ONE' }],
  }));
  assert.equal(artifact.operation.validation.pageCount, 2);
  assert.deepEqual(artifact.operation.validation.verifiedPages, [1]);
  assert.equal(JSON.stringify(artifact).includes('REMOVE PAGE ONE'), false);
  assert.equal(await store.verifySource(source.id), true);
});

test('verified raster redaction binds expected text to the selected region and preserves every non-target pixel', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/pdfdetach', '/opt/homebrew/bin/magick'].map((path) => access(path))); } catch { context.skip('Fixed Poppler and ImageMagick tools are unavailable.'); return; }
  const { store, service } = await fixture(context);
  const source = await store.createDocument({ stream: Readable.from([makeTextPdf('REGION BOUND SECRET')]), displayName: 'region.pdf' });
  const region = { x: 0.05, y: 0.03, width: 0.8, height: 0.14 };
  const artifact = await service.redact(source.id, verifiedRedaction(source, {
    pages: [1], redactions: [{ page: 1, region, removedText: 'REGION BOUND SECRET' }],
  }));
  assert.equal(artifact.operation.validation.targetPixelCount > 0, true);
  assert.equal(artifact.operation.validation.nonTargetChangedPixels, 0);
  await assert.rejects(service.redact(source.id, verifiedRedaction(source, {
    pages: [1],
    redactions: [{ page: 1, region: { x: 0.05, y: 0.6, width: 0.8, height: 0.14 }, removedText: 'REGION BOUND SECRET' }],
  })), { code: 'REDACTION_TEXT_NOT_FOUND', status: 422 });
  await assert.rejects(service.redact(source.id, {
    profile: 'verified-raster-burn-v2', sourceSha256: '0'.repeat(64),
    redactions: [{ page: 1, region, removedText: 'REGION BOUND SECRET' }],
  }), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });
  await assert.rejects(service.redact(source.id, {
    sourceSha256: source.sha256,
    redactions: [{ page: 1, region, removedText: 'REGION BOUND SECRET' }],
  }), { code: 'INVALID_REDACTION_PROFILE', status: 400 });

  const rotated = await store.createDocument({
    stream: Readable.from([makeTextPdf('ROTATED REGION SECRET', { rotations: [90] })]),
    displayName: 'rotated.pdf',
  });
  await assert.rejects(service.redact(rotated.id, verifiedRedaction(rotated, {
    pages: [1],
    redactions: [{ page: 1, fullPage: true, removedText: 'ROTATED REGION SECRET' }],
  })), { code: 'REDACTION_PAGE_ROTATION_UNSUPPORTED', status: 422 });

  const cropped = await store.createDocument({
    stream: Readable.from([makeTextPdf('CROPPED REGION SECRET', { cropBoxes: [[18, 18, 594, 774]] })]),
    displayName: 'cropped.pdf',
  });
  await assert.rejects(service.redact(cropped.id, verifiedRedaction(cropped, {
    pages: [1],
    redactions: [{ page: 1, fullPage: true, removedText: 'CROPPED REGION SECRET' }],
  })), { code: 'REDACTION_PAGE_CROP_UNSUPPORTED', status: 422 });
  assert.equal(await store.verifySource(source.id), true);
});
