import test from 'node:test';
import * as fixture from './support/host-pdf-service-fixture.js';

const {
  access, assert, assertWorkspaceQuota, convertSignatureContentsToDer, createReadStream,
  decodePng, DocumentStore, EngineRegistry, encodeRgbaPng, execFileAsync,
  executeOfflineSignatureInspection, HostError, join, link, makeInspectionPdf,
  makeMultiPagePdf, makePdfsigOutput, makeTextPdf, measureWorkspaceBytes, mkdir,
  mkdtemp, nativePackageRoot, OcrImageAdapter, parseAttachments, parseCustomMetadata,
  parseDocumentUrls, parseFonts, parseImages, parseNamedDestinations, parsePageBoxes,
  parsePageDimensions, parsePdfInfo, parseSignatures, parseTaggedStructure,
  parseTesseractLanguages, parseTesseractTsv, parseTextPages, PdfService,
  POPPLER_DESTINATION_HEADER, PopplerAdapter, projectRoot, readFile, Readable, rename,
  rm, SignatureTrustAdapter, stageSignatureTrustHelper, symlink, TesseractAdapter, tmpdir,
  validateAltoEvidence, validateOcrBatchManifest, validateOcrDocumentResult,
  validateOcrLayoutResult, validatePages, verifyStagedSignatureTrustHelper, writeFile,
} = fixture;

test('installed Poppler performs inspect, text, thumbnail, font and derived-page operations', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/pdffonts', '/opt/homebrew/bin/pdfdetach', '/opt/homebrew/bin/pdfseparate', '/opt/homebrew/bin/pdfsig'].map((path) => access(path)));
  } catch {
    context.skip('Poppler integration tools are not installed in the fixed engine search path.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'platen-service-test-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const registry = new EngineRegistry();
  const adapter = new PopplerAdapter({ registry });
  const service = new PdfService({ store, registry, adapter });
  const bytes = makeTextPdf('Platen local search', { attachment: { name: 'note.txt', content: 'private note' } });
  const document = await store.createDocument({ stream: Readable.from([bytes]), displayName: 'fixture.pdf' });

  const inspection = await service.inspect(document.id);
  assert.equal(inspection.pageCount, 1);
  assert.equal(inspection.pdfVersion, '1.7');

  const pages = await service.extractText(document.id, inspection.pageCount);
  assert.match(pages[0].text, /Platen local search/);

  const thumbnail = await service.renderThumbnail(document.id, { page: 1, dpi: 72 });
  assert.deepEqual([...thumbnail.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const cropBoxRaster = await service.renderCropBoxPage(document.id, { page: 1, dpi: 72 });
  assert.deepEqual([...cropBoxRaster.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const fonts = await service.listFonts(document.id);
  assert.equal(fonts.some(({ name }) => /Helvetica/.test(name)), true);

  const attachments = await service.listAttachments(document.id);
  assert.deepEqual(attachments.map(({ name }) => name), ['note.txt']);

  const signatures = await service.verifySignatures(document.id);
  assert.equal(signatures.status, 'unsigned');
  assert.equal(signatures.signatureCount, 0);
  assert.equal(signatures.sourceSha256, document.sha256);
  assert.equal('raw' in signatures, false);

  const artifact = await service.extractPages(document.id, [1]);
  assert.equal(artifact.operation.type, 'extract-pages');
  assert.equal(artifact.documentId, document.id);
  assert.equal(await store.verifySource(document.id), true);
});

test('CropBox rendering keeps every native source read on one immutable staged copy across a store-path swap', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-cropbox-source-race-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const original = makeTextPdf('IMMUTABLE CROPBOX SOURCE');
  const document = await store.createDocument({ stream: Readable.from([original]), displayName: 'source.pdf' });
  const writableSource = store.getSourcePath(document.id);
  const backup = `${writableSource}.before-swap`;
  const calls = [];
  let swapped = false;
  const adapter = {
    async execute(operation, parameters) {
      calls.push({ operation, input: parameters.input });
      assert.notEqual(parameters.input, writableSource, 'native source operations must not reopen the writable store path');
      assert.deepEqual(await readFile(parameters.input), original, 'native source operations must read the staged original bytes');
      if (operation === 'inspect') {
        await rename(writableSource, backup);
        await writeFile(writableSource, makeTextPdf('HOSTILE REPLACEMENT'));
        swapped = true;
        return { stdout: 'Pages: 1\nEncrypted: no\nPage size: 612 x 792 pts\n' };
      }
      assert.equal(operation, 'renderCropBoxPagePng');
      await writeFile(`${parameters.outputPrefix}.png`, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      await rm(writableSource);
      await rename(backup, writableSource);
      return { stdout: '' };
    },
  };
  const service = new PdfService({ store, registry: {}, adapter });
  const output = await service.renderCropBoxPage(document.id, { page: 1, dpi: 72 });
  assert.equal(swapped, true);
  assert.deepEqual(calls.map(({ operation }) => operation), ['inspect', 'renderCropBoxPagePng']);
  assert.deepEqual([...output], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(await store.verifySource(document.id), true);
});

test('CropBox snapshot crops the source-bound passive page raster without reopening PDF bytes', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'platen-cropbox-snapshot-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const document = await store.createDocument({ stream: Readable.from([makeTextPdf('SNAPSHOT SOURCE')]), displayName: 'source.pdf' });
  const sourceRaster = encodeRgbaPng({
    width: 4,
    height: 4,
    pixels: Buffer.from(Array.from({ length: 16 }, (_, index) => [index, index + 1, index + 2, 255]).flat()),
  });
  const calls = [];
  const adapter = {
    async execute(operation, parameters) {
      calls.push(operation);
      if (operation === 'inspect') return { stdout: 'Pages: 1\nEncrypted: no\nPage size: 612 x 792 pts\n' };
      assert.equal(operation, 'renderCropBoxPagePng');
      await writeFile(`${parameters.outputPrefix}.png`, sourceRaster);
      return { stdout: '' };
    },
  };
  const service = new PdfService({ store, registry: {}, adapter });
  const snapshot = await service.renderCropBoxSnapshot(document.id, {
    page: 1, dpi: 192, region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
  });
  const decoded = decodePng(snapshot);
  assert.deepEqual({ width: decoded.width, height: decoded.height }, { width: 2, height: 2 });
  assert.deepEqual(calls, ['inspect', 'renderCropBoxPagePng']);
  assert.equal(await store.verifySource(document.id), true);
});

