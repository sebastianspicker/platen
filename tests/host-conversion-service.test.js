import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { GhostscriptAdapter } from '../scripts/host/adapters/ghostscript.mjs';
import { ImageMagickAdapter } from '../scripts/host/adapters/imagemagick.mjs';
import { LibreOfficeAdapter } from '../scripts/host/adapters/libreoffice.mjs';
import { PopplerAdapter } from '../scripts/host/adapters/poppler.mjs';
import { ConversionService, assertInlineOnlyHtml } from '../scripts/host/conversion-service.mjs';
import { prepareBlankDocumentExport } from '../scripts/host/conversion-blank-export.mjs';
import { preparePngPdfDocumentExport } from '../scripts/host/conversion-png-export.mjs';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { EngineRegistry } from '../scripts/host/engine-registry.mjs';
import { InputAssetStore } from '../scripts/host/input-asset-store.mjs';
import { createBlankPdf, createTextPdf } from '../scripts/host/pdf-factory.mjs';
import { createProcessLimiter } from '../scripts/host/process-runner.mjs';
import { encodeRgbaPng } from '../scripts/host/raster-png-codec.mjs';

const onePixelPng = encodeRgbaPng({
  width: 1,
  height: 1,
  pixels: Buffer.from([255, 255, 255, 255]),
});

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'platen-conversion-test-'));
  const documents = await new DocumentStore({ root }).initialize();
  const inputs = await new InputAssetStore({ root }).initialize();
  context.after(() => documents.dispose());
  const runner = createProcessLimiter({ concurrency: 2, maximumQueued: 8 });
  const registry = new EngineRegistry({ runner });
  const poppler = new PopplerAdapter({ registry, runner });
  return {
    documents,
    inputs,
    poppler,
    service: new ConversionService({
      documents,
      inputs,
      poppler,
      ghostscript: new GhostscriptAdapter({ registry, runner }),
      libreOffice: new LibreOfficeAdapter({ registry, runner }),
      imageMagick: new ImageMagickAdapter({ registry, runner }),
    }),
  };
}

async function extractedText(poppler, path) {
  const result = await poppler.execute('extractText', { input: path, layout: false });
  return result.stdout;
}

test('inline HTML policy rejects active and external content', () => {
  assert.doesNotThrow(() => assertInlineOnlyHtml(Buffer.from('<!doctype html><p style="color:red">Local</p>')));
  assert.throws(() => assertInlineOnlyHtml(Buffer.from('<script>alert(1)</script>')), { code: 'HTML_EXTERNAL_CONTENT_FORBIDDEN' });
  assert.throws(() => assertInlineOnlyHtml(Buffer.from('<img src="https://example.test/a.png">')), { code: 'HTML_EXTERNAL_CONTENT_FORBIDDEN' });
});

test('local factory creates derived blank and clipboard-style text PDFs', async (context) => {
  const { service, documents, poppler } = await fixture(context);
  const blank = await service.createBlank({ pages: 2, widthPoints: 612, heightPoints: 792, title: 'Blank' });
  assert.equal(blank.origin, 'derived');
  assert.equal(blank.operation.type, 'create-blank-pdf');
  const text = await service.createText({ text: 'CLIPBOARD LOCAL', title: 'Clipboard' });
  assert.match(await extractedText(poppler, documents.getSourcePath(text.id)), /CLIPBOARD LOCAL/);
});

test('blank export pipes one verified snapshot despite source and workspace path swaps', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-blank-export-test-'));
  const documents = await new DocumentStore({ root }).initialize();
  context.after(() => documents.dispose());
  const originalBytes = createBlankPdf({ pages: 2, title: 'Untitled' });
  const replacementBytes = createBlankPdf({ pages: 1, title: 'Replacement' });
  const document = await documents.createDocument({
    stream: Readable.from([originalBytes]),
    displayName: 'untitled.pdf',
  });
  const storedPath = documents.getSourcePath(document.id);
  const heldPath = `${storedPath}.held`;
  const stdinSnapshots = [];
  const operations = [];
  const poppler = {
    async execute(operation, _parameters, options) {
      operations.push(operation);
      stdinSnapshots.push(options.stdin);
      assert.equal(Buffer.isBuffer(options.stdin), true);
      assert.equal(options.stdin.equals(originalBytes), true);
      const displacedWorkspace = `${options.cwd}.held`;
      await rename(options.cwd, displacedWorkspace);
      await mkdir(options.cwd, { mode: 0o700 });
      await writeFile(
        join(options.cwd, 'immutable-blank-source.pdf'),
        replacementBytes,
        { mode: 0o600 },
      );
      await rm(options.cwd, { recursive: true });
      await rename(displacedWorkspace, options.cwd);
      if (operation === 'inspectStdin') {
        await rename(storedPath, heldPath);
        await writeFile(storedPath, replacementBytes, { mode: 0o600 });
        await rm(storedPath);
        await rename(heldPath, storedPath);
        return {
          stdout: 'Title: Untitled\nPages: 2\nEncrypted: no\nJavaScript: no\nForm: none\n',
        };
      }
      if (operation === 'inspectPageStdin') {
        return { stdout: 'Page 1 size: 612 x 792 pts\n' };
      }
      if (operation === 'extractTextStdin') return { stdout: '\f\f' };
      throw new Error(`Unexpected operation: ${operation}`);
    },
  };

  const prepared = await prepareBlankDocumentExport({
    documents,
    poppler,
    documentId: document.id,
    pages: 2,
  });
  assert.equal(prepared.bytes.equals(originalBytes), true);
  assert.deepEqual(operations, ['inspectStdin', 'inspectPageStdin', 'extractTextStdin']);
  assert.equal(new Set(stdinSnapshots).size, 1);
  assert.equal(await documents.verifySource(document.id), true);
});

test('PNG PDF export binds every Poppler check to the returned snapshot bytes', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-png-export-test-'));
  const documents = await new DocumentStore({ root }).initialize();
  context.after(() => documents.dispose());
  const originalBytes = createBlankPdf({ title: 'Image conversion output' });
  const replacementBytes = createBlankPdf({ title: 'Workspace replacement' });
  const document = await documents.createDocument({
    stream: Readable.from([originalBytes]), displayName: 'image.pdf',
  });
  const operations = [];
  const stdinSnapshots = [];
  const poppler = {
    async execute(operation, _parameters, options) {
      operations.push(operation);
      stdinSnapshots.push(options.stdin);
      assert.equal(options.stdin.equals(originalBytes), true);
      const displacedWorkspace = `${options.cwd}.held`;
      await rename(options.cwd, displacedWorkspace);
      await mkdir(options.cwd, { mode: 0o700 });
      await writeFile(
        join(options.cwd, 'immutable-png-document.pdf'),
        replacementBytes,
        { mode: 0o600 },
      );
      await rm(options.cwd, { recursive: true });
      await rename(displacedWorkspace, options.cwd);
      if (operation === 'inspectStdin') {
        return { stdout: 'Pages: 1\nEncrypted: no\nJavaScript: no\nForm: none\n' };
      }
      if (operation === 'inspectPageStdin') {
        return { stdout: 'Page 1 size: 612 x 792 pts\n' };
      }
      if (operation === 'extractTextStdin') return { stdout: '\f' };
      if (operation === 'listImagesStdin') {
        return { stdout: 'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio\n1 0 image 2 3 rgb 3 8 image no 4 0 72 72 18B 1%\n' };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    },
  };
  const prepared = await preparePngPdfDocumentExport({
    documents, poppler, documentId: document.id,
  });
  assert.equal(prepared.bytes.equals(originalBytes), true);
  assert.deepEqual(
    operations,
    ['inspectStdin', 'inspectPageStdin', 'extractTextStdin', 'listImagesStdin'],
  );
  assert.equal(new Set(stdinSnapshots).size, 1);
  assert.equal(prepared.images[0].width, 2);
  assert.equal(await documents.verifySource(document.id), true);
});

test('office/text fallback writes a local PDF when LibreOffice aborts and keeps legacy formats typed', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-fallback-test-'));
  const documents = await new DocumentStore({ root }).initialize();
  const inputs = await new InputAssetStore({ root }).initialize();
  context.after(() => documents.dispose());
  const service = new ConversionService({
    documents, inputs,
    poppler: { execute: async () => ({ stdout: 'Pages: 1\n' }) },
    ghostscript: { execute: async () => { throw new Error('not used'); } },
    imageMagick: { execute: async () => { throw new Error('not used'); } },
    libreOffice: { execute: async () => { const error = new Error('soffice aborted'); error.code = 'ENGINE_PROCESS_FAILED'; error.exitCode = 134; throw error; } },
  });
  const text = await inputs.createInput({ stream: Readable.from([Buffer.from('FALLBACK LOCAL TEXT')]), displayName: 'notes.txt', mediaType: 'text/plain' });
  const converted = await service.convertInput(text.id);
  assert.equal(converted.operation.type, 'office-to-pdf');
  assert.deepEqual(converted.operation.validation.validators, ['source-sha256', 'pdfinfo-page-count']);
  assert.match((await readFile(documents.getSourcePath(converted.id))).toString('binary'), /FALLBACK LOCAL TEXT/);

  const legacy = await inputs.createInput({
    stream: Readable.from([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])]), displayName: 'legacy.doc', mediaType: 'application/msword',
  });
  await assert.rejects(service.convertInput(legacy.id), { code: 'LEGACY_OFFICE_FORMAT_REQUIRES_LIBREOFFICE', status: 422 });
});

test('LibreOffice or the deterministic text fallback converts text to a validated PDF', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext'].map((path) => access(path)));
  } catch {
    context.skip('The fixed local Poppler tools are unavailable.');
    return;
  }
  const { service, documents, inputs, poppler } = await fixture(context);
  const source = await inputs.createInput({ stream: Readable.from([Buffer.from('LIBREOFFICE LOCAL')]), displayName: 'notes.txt', mediaType: 'text/plain' });
  const officeDocument = await service.convertInput(source.id);
  assert.equal(officeDocument.operation.type, 'office-to-pdf');
  assert.match(await extractedText(poppler, documents.getSourcePath(officeDocument.id)), /LIBREOFFICE LOCAL/);
  assert.equal(await inputs.verifyInput(source.id), true);
});

test('installed ImageMagick converts raster input independently from Office conversion', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/magick'].map((path) => access(path))); } catch {
    context.skip('The fixed ImageMagick and Poppler tools are unavailable.'); return;
  }
  const { service, inputs } = await fixture(context);
  const source = await inputs.createInput({ stream: Readable.from([onePixelPng]), displayName: 'pixel.png', mediaType: 'image/png' });
  const imageDocument = await service.convertInput(source.id);
  assert.equal(imageDocument.operation.type, 'image-to-pdf');
  assert.deepEqual(imageDocument.operation.validation.validators, ['source-sha256', 'imagemagick-exit-zero', 'pdfinfo-page-count']);
  assert.equal(imageDocument.operation.validation.pageCount, 1);
});

test('raster conversion path accepts JPEG and TIFF files through the ImageMagick raster pipeline', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-image-admission-test-'));
  const documents = await new DocumentStore({ root }).initialize();
  const inputs = await new InputAssetStore({ root }).initialize();
  context.after(() => documents.dispose());
  const conversionOutputs = [];
  const poppler = { async execute() { return { stdout: 'Pages: 1\\n' }; } };
  const service = new ConversionService({
    documents,
    inputs,
    poppler,
    ghostscript: { execute: async () => { throw new Error('not used'); } },
    libreOffice: { execute: async () => { throw new Error('not used'); } },
    imageMagick: {
      async execute(operation, { input, output }) {
        conversionOutputs.push({ operation, input, output });
        await writeFile(output, createTextPdf({ pages: ['Scanned image page'] }), { mode: 0o600 });
      },
    },
  });
  const jpeg = await inputs.createInput({
    stream: Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]),
    displayName: 'photo.jpg',
    mediaType: 'image/jpeg',
  });
  const jpegPdf = await service.convertInput(jpeg.id);
  assert.equal(jpegPdf.operation.type, 'image-to-pdf');
  assert.deepEqual(jpegPdf.operation.validation.validators, ['source-sha256', 'imagemagick-exit-zero', 'pdfinfo-page-count']);
  assert.equal(jpegPdf.operation.validation.pageCount, 1);
  const tiff = await inputs.createInput({
    stream: Readable.from([Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08])]),
    displayName: 'document.tiff',
    mediaType: 'image/tiff',
  });
  const tiffPdf = await service.convertInput(tiff.id);
  assert.equal(tiffPdf.operation.type, 'image-to-pdf');
  assert.deepEqual(tiffPdf.operation.validation.validators, ['source-sha256', 'imagemagick-exit-zero', 'pdfinfo-page-count']);
  assert.equal(tiffPdf.operation.validation.pageCount, 1);
  assert.deepEqual(conversionOutputs.map((entry) => entry.operation), ['convertRasterToPdf', 'convertRasterToPdf']);
});

test('image conversion rejects unsupported image formats and malformed PNG assets with input-domain errors', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-image-admission-test-'));
  const documents = await new DocumentStore({ root }).initialize();
  const inputs = await new InputAssetStore({ root }).initialize();
  context.after(() => documents.dispose());
  const unused = { execute: async () => { throw new Error('Native conversion must not start.'); } };
  const service = new ConversionService({
    documents,
    inputs,
    poppler: unused,
    ghostscript: unused,
    libreOffice: unused,
    imageMagick: unused,
  });
  const gif = await inputs.createInput({
    stream: Readable.from([Buffer.from('GIF89a', 'ascii')]),
    displayName: 'scan.gif',
    mediaType: 'image/gif',
  });
  await assert.rejects(service.convertInput(gif.id), {
    code: 'UNSUPPORTED_INPUT_FORMAT', status: 415,
  });
  const truncated = await inputs.createInput({
    stream: Readable.from([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]),
    displayName: 'truncated.png',
    mediaType: 'image/png',
  });
  await assert.rejects(service.convertInput(truncated.id), {
    code: 'UNSUPPORTED_PNG_INPUT', status: 415,
  });
});

test('installed Ghostscript converts PostScript independently from Office conversion', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/gs'].map((path) => access(path))); } catch {
    context.skip('The fixed Ghostscript and Poppler tools are unavailable.'); return;
  }
  const { service, documents, inputs, poppler } = await fixture(context);
  const source = await inputs.createInput({
    stream: Readable.from([Buffer.from('%!PS-Adobe-3.0\n/Helvetica findfont 18 scalefont setfont\n72 720 moveto\n(POSTSCRIPT LOCAL) show\nshowpage\n')]), displayName: 'page.ps', mediaType: 'application/postscript',
  });
  const postscriptDocument = await service.convertInput(source.id);
  assert.equal(postscriptDocument.operation.type, 'postscript-to-pdf');
  assert.match(await extractedText(poppler, documents.getSourcePath(postscriptDocument.id)), /POSTSCRIPT LOCAL/);
  assert.equal(await inputs.verifyInput(source.id), true);
});

test('installed Ghostscript rewrites a PDF without changing page count or source bytes', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/gs'].map((path) => access(path)));
  } catch {
    context.skip('The fixed Ghostscript and Poppler tools are unavailable.');
    return;
  }
  const { service, documents } = await fixture(context);
  const source = await documents.createDocument({
    stream: Readable.from([createTextPdf({ pages: ['One', 'Two'] })]), displayName: 'source.pdf',
  });
  const optimized = await service.rewriteDocument(source.id, 'optimize');
  assert.equal(optimized.origin, 'derived');
  assert.equal(optimized.operation.type, 'optimize-pdf');
  assert.equal(optimized.operation.validation.pageCount, 2);
  assert.equal(await documents.verifySource(source.id), true);
});
