import test from 'node:test';
import * as fixture from './support/host-pdf-service-fixture.js';
import { makeXrefStreamPdf } from './support/pdf-xref-stream-fixture.js';

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

test('installed Poppler preserves requested order for arrangements and merge outputs', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdfseparate', '/opt/homebrew/bin/pdfunite'].map((path) => access(path)));
  } catch {
    context.skip('Poppler page composition tools are not installed in the fixed engine search path.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-compose-test-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const registry = new EngineRegistry();
  const adapter = new PopplerAdapter({ registry });
  const service = new PdfService({ store, registry, adapter });
  const primary = await store.createDocument({
    stream: Readable.from([makeMultiPagePdf(['First page', 'Second page', 'Third page'])]), displayName: 'primary.pdf',
  });
  const secondary = await store.createDocument({
    stream: Readable.from([makeTextPdf('Fourth page')]), displayName: 'secondary.pdf',
  });

  const arranged = await service.arrangePages(primary.id, [3, 1]);
  const arrangedDocument = await store.createDocument({
    stream: createReadStream(store.getArtifact(arranged.id).filePath), displayName: 'arranged.pdf',
  });
  const arrangedInfo = await service.inspect(arrangedDocument.id);
  const arrangedText = await service.extractText(arrangedDocument.id, arrangedInfo.pageCount);
  assert.equal(arrangedInfo.pageCount, 2);
  assert.match(arrangedText[0].text, /Third page/);
  assert.match(arrangedText[1].text, /First page/);

  const merged = await service.mergeDocuments(primary.id, secondary.id);
  const mergedDocument = await store.createDocument({
    stream: createReadStream(store.getArtifact(merged.id).filePath), displayName: 'merged.pdf',
  });
  const mergedInfo = await service.inspect(mergedDocument.id);
  const mergedText = await service.extractText(mergedDocument.id, mergedInfo.pageCount);
  assert.equal(mergedInfo.pageCount, 4);
  assert.match(mergedText[3].text, /Fourth page/);
  assert.equal(await store.verifySource(primary.id), true);
  assert.equal(await store.verifySource(secondary.id), true);
});

test('installed Poppler copies exactly one staged secondary page at the requested primary position', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/pdfseparate', '/opt/homebrew/bin/pdfunite', '/opt/homebrew/bin/pdfsig'].map((path) => access(path))); } catch { context.skip('Poppler copy-page tools are not installed in the fixed engine search path.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'platen-copy-page-test-'));
  const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose());
  const registry = new EngineRegistry(); const service = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const primary = await store.createDocument({ stream: Readable.from([makeMultiPagePdf(['First', 'Second', 'Third'])]), displayName: 'primary.pdf' });
  const secondary = await store.createDocument({ stream: Readable.from([makeMultiPagePdf(['Alpha', 'Beta'])]), displayName: 'secondary.pdf' });
  const artifact = await service.copyPageBetweenDocuments(primary.id, secondary.id, { profile: 'local-copy-one-page-between-documents-v1', primarySourceSha256: primary.sha256, secondarySourceSha256: secondary.sha256, sourcePage: 2, afterPage: 1 });
  const adopted = await store.createDocument({ stream: createReadStream(store.getArtifact(artifact.id).filePath), displayName: 'copied.pdf' });
  const pages = await service.extractText(adopted.id, 4);
  assert.deepEqual(pages.map(({ text }) => text.trim()), ['First', 'Beta', 'Second', 'Third']);
  assert.equal(artifact.operation.type, 'copy-page-between-documents');
  assert.equal(artifact.operation.validation.manifestSha256.length, 64);
  assert.equal(JSON.stringify(artifact.operation).includes('primary-source.pdf'), false);
  assert.equal(await store.verifySource(primary.id), true); assert.equal(await store.verifySource(secondary.id), true);
});

test('copy-page rejects graph-only structures before Poppler splits either source', async (context) => {
  try { await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdftocairo', '/opt/homebrew/bin/pdfseparate', '/opt/homebrew/bin/pdfunite', '/opt/homebrew/bin/pdfsig'].map((path) => access(path))); } catch { context.skip('Poppler copy-page tools are not installed in the fixed engine search path.'); return; }
  const cases = [
    [
      makeTextPdf('Primary', { outlines: [{ title: 'Private outline', page: 1 }] }),
      makeTextPdf('Secondary'),
    ],
    [
      makeTextPdf('Primary'),
      makeXrefStreamPdf({ pageExtra: ' /Annots []' }),
    ],
  ];
  for (const [primaryBytes, secondaryBytes] of cases) {
    const root = await mkdtemp(join(tmpdir(), 'platen-copy-page-reject-'));
    const store = await new DocumentStore({ root }).initialize();
    context.after(() => store.dispose());
    const operations = [];
    const delegate = new PopplerAdapter({ registry: new EngineRegistry() });
    const adapter = {
      async execute(operation, ...args) {
        operations.push(operation);
        return delegate.execute(operation, ...args);
      },
    };
    const registry = new EngineRegistry();
    const service = new PdfService({ store, registry, adapter });
    const primary = await store.createDocument({
      stream: Readable.from([primaryBytes]), displayName: 'primary.pdf',
    });
    const secondary = await store.createDocument({
      stream: Readable.from([secondaryBytes]), displayName: 'secondary.pdf',
    });
    await assert.rejects(service.copyPageBetweenDocuments(primary.id, secondary.id, {
      profile: 'local-copy-one-page-between-documents-v1',
      primarySourceSha256: primary.sha256,
      secondarySourceSha256: secondary.sha256,
      sourcePage: 1,
      afterPage: 1,
    }), { code: 'COPY_PAGE_SOURCE_UNSUPPORTED', status: 422 });
    assert.equal(operations.includes('splitPages'), false);
    assert.equal(operations.includes('mergeDocuments'), false);
  }
});

test('installed Poppler performs split, duplicate, reverse, interleave, insert, and replace compositions', async (context) => {
  try {
    await Promise.all(['/opt/homebrew/bin/pdfinfo', '/opt/homebrew/bin/pdftotext', '/opt/homebrew/bin/pdfseparate', '/opt/homebrew/bin/pdfunite'].map((path) => access(path)));
  } catch {
    context.skip('Poppler page composition tools are not installed in the fixed engine search path.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'platen-compose-family-test-'));
  const store = await new DocumentStore({ root }).initialize();
  context.after(() => store.dispose());
  const registry = new EngineRegistry();
  const service = new PdfService({ store, registry, adapter: new PopplerAdapter({ registry }) });
  const primary = await store.createDocument({
    stream: Readable.from([makeMultiPagePdf(['First', 'Second', 'Third'])]), displayName: 'primary.pdf',
  });
  const secondary = await store.createDocument({
    stream: Readable.from([makeMultiPagePdf(['Alpha', 'Beta'])]), displayName: 'secondary.pdf',
  });

  async function artifactText(artifact) {
    const adopted = await store.createDocument({
      stream: createReadStream(store.getArtifact(artifact.id).filePath),
      displayName: artifact.displayName,
    });
    const inspection = await service.inspect(adopted.id);
    const pages = await service.extractText(adopted.id, inspection.pageCount);
    return { inspection, pages };
  }

  const duplicated = await service.duplicatePages(primary.id, [2]);
  assert.deepEqual((await artifactText(duplicated)).pages.map(({ text }) => text.trim()), ['First', 'Second', 'Second', 'Third']);
  assert.equal(duplicated.operation.type, 'duplicate-pages');
  assert.equal(duplicated.operation.validation.passed, true);

  const reversed = await service.reversePages(primary.id);
  assert.deepEqual((await artifactText(reversed)).pages.map(({ text }) => text.trim()), ['Third', 'Second', 'First']);

  const interleaved = await service.interleaveDocuments(primary.id, secondary.id);
  assert.deepEqual((await artifactText(interleaved)).pages.map(({ text }) => text.trim()), ['First', 'Alpha', 'Second', 'Beta', 'Third']);
  assert.equal(interleaved.operation.inputs.length, 2);

  const inserted = await service.insertDocument(primary.id, secondary.id, 1);
  assert.deepEqual((await artifactText(inserted)).pages.map(({ text }) => text.trim()), ['First', 'Alpha', 'Beta', 'Second', 'Third']);

  const replaced = await service.replacePages(primary.id, secondary.id, 2, 3);
  assert.deepEqual((await artifactText(replaced)).pages.map(({ text }) => text.trim()), ['First', 'Alpha', 'Beta']);

  const split = await service.splitDocument(primary.id);
  assert.equal(split.length, 3);
  assert.deepEqual(await Promise.all(split.map(async (artifact) => (await artifactText(artifact)).pages[0].text.trim())), ['First', 'Second', 'Third']);
  assert.equal(split.every((artifact) => artifact.operation.type === 'split-document'), true);

  const splitByRule = await service.splitByPageCount(primary.id, 2);
  assert.equal(splitByRule.length, 2);
  assert.deepEqual(await Promise.all(splitByRule.map(async (artifact) => (await artifactText(artifact)).pages.map(({ text }) => text.trim()))), [
    ['First', 'Second'], ['Third'],
  ]);
  assert.equal(splitByRule.every((artifact) => artifact.operation.type === 'split-by-page-count'), true);
  assert.deepEqual(splitByRule.map((artifact) => ({ ...artifact.operation.parameters.splitRule })), [
    { kind: 'every-pages', pagesPerOutput: 2, outputIndex: 1, outputCount: 2 },
    { kind: 'every-pages', pagesPerOutput: 2, outputIndex: 2, outputCount: 2 },
  ]);
  await assert.rejects(service.splitByPageCount(primary.id, 0), { code: 'INVALID_SPLIT_RULE' });

  assert.equal(await store.verifySource(primary.id), true);
  assert.equal(await store.verifySource(secondary.id), true);
});
