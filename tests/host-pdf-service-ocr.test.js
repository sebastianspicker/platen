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

test('installed Poppler inventories page boxes, metadata, destinations, URLs, and tag evidence read-only', async (context) => {
  try {
    await access('/opt/homebrew/bin/pdfinfo');
  } catch {
    context.skip('Poppler pdfinfo is not installed in the fixed engine search path.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-structure-test-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const registry = new EngineRegistry();
  const service = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const source = await store.createDocument({
    stream: Readable.from([makeInspectionPdf()]), displayName: 'structure.pdf',
  });
  const evidence = await service.inspectStructure(source.id);
  assert.equal(evidence.sourceDigest, source.sha256);
  assert.equal(evidence.pageBoxes[0].boxes.cropBox.left, 18);
  assert.equal(evidence.xmpMetadata.present, true);
  assert.match(evidence.xmpMetadata.xml, /<local>offline<\/local>/);
  assert.equal(evidence.customMetadata.some(({ name, value }) => name === 'Department' && value === 'Prepress'), true);
  assert.equal(evidence.namedDestinations.items.some(({ name }) => name.includes('chapter-one')), true);
  assert.equal(evidence.urls.some(({ url }) => url === 'https://example.test/local'), true);
  assert.equal(evidence.engine.preservesSource, true);
  assert.equal(evidence.unsupported.includes('optional-content-layers'), true);
  assert.equal(await store.verifySource(source.id), true);
});

test('render geometry and page composition limits fail before native processing', () => {
  assert.throws(
    () => parsePageDimensions('Page 1 size: 20000 x 792 pts\n', 1),
    { code: 'PAGE_GEOMETRY_LIMIT', status: 422 },
  );
  assert.throws(
    () => validatePages(Array.from({ length: 501 }, (_, index) => index + 1), 1_000),
    { code: 'COMPOSE_PAGE_LIMIT', status: 422 },
  );
});

test('job workspace quota counts cumulative intermediate files', async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), 'platen-quota-test-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(workspace, 'one.bin'), Buffer.alloc(7)),
    writeFile(join(workspace, 'two.bin'), Buffer.alloc(9)),
  ]);
  assert.equal(await measureWorkspaceBytes(workspace), 16);
  await assert.rejects(assertWorkspaceQuota(workspace, 15), {
    code: 'JOB_WORKSPACE_LIMIT', status: 413,
  });
});

test('job workspace inventory counts nested files and rejects links', async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), 'platen-workspace-inventory-test-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const nested = join(workspace, 'nested');
  await mkdir(nested);
  await writeFile(join(nested, 'output.bin'), Buffer.alloc(11));
  assert.equal(await measureWorkspaceBytes(workspace), 11);

  const symbolic = join(workspace, 'symbolic.bin');
  await symlink(join(nested, 'output.bin'), symbolic);
  await assert.rejects(measureWorkspaceBytes(workspace), { code: 'JOB_WORKSPACE_INVALID', status: 502 });
  await rm(symbolic);

  const hardLink = join(workspace, 'hard-link.bin');
  await link(join(nested, 'output.bin'), hardLink);
  await assert.rejects(measureWorkspaceBytes(workspace), { code: 'JOB_WORKSPACE_INVALID', status: 502 });
});

test('OCR admits only one local job at a time', async () => {
  let releaseLanguages;
  const languageGate = new Promise((resolve) => { releaseLanguages = resolve; });
  const service = new PdfService({
    store: {},
    registry: {},
    adapter: {},
    ocrAdapter: { execute: async () => languageGate },
  });
  const first = service.ocrDocument('document', { language: 'eng' });
  await assert.rejects(
    service.ocrDocument('document', { language: 'eng' }),
    { code: 'OCR_BUSY', status: 409 },
  );
  releaseLanguages({ stdout: 'eng\n', stderr: '' });
  await assert.rejects(first);
});

test('OCR document and layout analysis share the same local job lock', async () => {
  let releaseLanguages;
  const languageGate = new Promise((resolve) => { releaseLanguages = resolve; });
  const service = new PdfService({
    store: {}, registry: {}, adapter: {}, ocrImageAdapter: {},
    ocrAdapter: { execute: async () => languageGate },
  });
  const first = service.ocrDocument('document', { language: 'eng' });
  await assert.rejects(
    service.analyzeOcrLayout('document', { pages: [1] }),
    { code: 'OCR_BUSY', status: 409 },
  );
  releaseLanguages({ stdout: 'eng\n', stderr: '' });
  await assert.rejects(first);
});

test('invalid OCR modes fail before acquiring the single-job lock', async () => {
  const service = new PdfService({ store: {}, registry: {}, adapter: {}, ocrAdapter: { execute: async () => ({ stdout: 'eng\n', stderr: '' }) } });
  await assert.rejects(service.ocrDocument('document', { cleanupPreset: 'unsafe' }), { code: 'INVALID_OCR_CLEANUP', status: 400 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.ocrDocument('document', { cleanupPreset: 'none', signal: controller.signal }));
});

test('OCR layout zones require typed non-overlapping rectangles', async () => {
  const service = new PdfService({ store: {}, registry: {}, adapter: {}, ocrAdapter: {}, ocrImageAdapter: {} });
  await assert.rejects(service.analyzeOcrLayout('document', {
    pages: [1], zones: [{ id: 'missing-type', page: 1, x: 0, y: 0, width: 0.4, height: 0.4 }],
  }), { code: 'INVALID_OCR_ZONES', status: 400 });
  await assert.rejects(service.analyzeOcrLayout('document', {
    pages: [1], zones: [
      { id: 'text', type: 'text', page: 1, x: 0, y: 0, width: 0.6, height: 0.6 },
      { id: 'table', type: 'table', page: 1, x: 0.5, y: 0.5, width: 0.4, height: 0.4 },
    ],
  }), { code: 'INVALID_OCR_ZONES', status: 400 });
});

test('installed Tesseract creates a searchable, rasterized OCR PDF with review evidence', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/pdfunite', '/opt/homebrew/bin/tesseract', '/opt/homebrew/bin/magick'].map((path) => access(path)));
  } catch {
    context.skip('The fixed Poppler and Tesseract OCR toolchain is not installed.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-ocr-test-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const registry = new EngineRegistry();
  const adapter = new PopplerAdapter({ registry });
  const ocrAdapter = new TesseractAdapter({ registry });
  const ocrImageAdapter = new OcrImageAdapter({ registry });
  const service = new PdfService({ store, registry, adapter, ocrAdapter, ocrImageAdapter });
  const source = await store.createDocument({
    stream: Readable.from([makeTextPdf('HELLO OCR TEST')]), displayName: 'scan.pdf',
  });

  assert.equal((await service.ocrLanguages()).includes('eng'), true);
  const ocr = validateOcrDocumentResult(await service.ocrDocument(source.id, { language: 'eng', cleanupPreset: 'document', segmentation: 'block', userDictionary: ['OCRTESTTERM'] }));
  const { artifact, result } = ocr;
  assert.equal(result.rasterized, true);
  assert.equal(result.pageCount, 1);
  assert.ok(result.recognizedWordCount > 0);
  assert.ok(Array.isArray(result.suspects));
  assert.equal(result.cleanupPreset, 'document');
  assert.equal(result.segmentation, 'block');
  assert.deepEqual(result.userDictionary, { termCount: 1, digest: '1efebc219e974a707cdb27dbe5d45ce4a5ed6e751365bab4e4d039671c434256' });
  assert.equal(JSON.stringify(ocr).includes('OCRTESTTERM'), false);
  assert.equal(ocr.kind, 'searchable-ocr-document');
  assert.equal(ocr.schemaVersion, 1);
  assert.equal(ocr.sourceDigest, source.sha256);
  assert.equal(ocr.evidence.cleanupReceipts.length, 1);
  assert.equal(ocr.evidence.cleanupReceipts[0].applied, true);
  assert.equal(ocr.evidence.cleanupReceipts[0].canvasPreserved, true);
  assert.match(ocr.evidence.cleanupReceipts[0].pre.sha256, /^[a-f0-9]{64}$/);
  assert.match(ocr.evidence.cleanupReceipts[0].post.sha256, /^[a-f0-9]{64}$/);

  const layout = validateOcrLayoutResult(await service.analyzeOcrLayout(source.id, {
    language: 'eng', pages: [1], cleanupPreset: 'document', segmentation: 'block', detectTables: false,
  }));
  assert.equal(layout.kind, 'ocr-layout-evidence');
  assert.equal(layout.schemaVersion, 1);
  assert.equal(layout.records.length, 1);
  assert.ok(layout.records[0].recognizedWordCount > 0);
  assert.equal(layout.records[0].alto.mediaType, 'application/alto+xml');
  assert.equal(layout.records[0].tableCandidates.length, 0);
  assert.equal(layout.sourceDigest, source.sha256);
  assert.equal(layout.evidence.sourceBound, true);

  const batch = validateOcrBatchManifest(await service.ocrBatchDocuments([{
    id: 1, documentId: source.id, kind: 'document', options: { language: 'eng', cleanupPreset: 'document', segmentation: 'block' },
  }]));
  assert.equal(batch.status, 'succeeded');
  assert.equal(batch.requests[0].status, 'completed');
  assert.equal(batch.requests[0].output.sourceDigest, source.sha256);

  const searchable = await store.createDocument({
    stream: createReadStream(store.getArtifact(artifact.id).filePath), displayName: artifact.displayName,
  });
  const info = await service.inspect(searchable.id);
  const pages = await service.extractText(searchable.id, info.pageCount);
  assert.match(pages[0].text, /HELLO OCR TEST/i);
  assert.equal(await store.verifySource(source.id), true);
});
