import * as setup from "./support/professional-capability-delivery-test-setup.js";

const {
  assert, createHash, readFileSync, join, test, deliverProfessionalCapability,
  listProfessionalHandlers, getProfessionalHandler, resetAiPolicyForTests,
  validateComparisonPackage, inspectPdfPrinterMarks, createBlankPdf, createTextPdf,
  decodePng, encodeRgbaPng, readZipEntries, redactionFixture, formFixture,
  editableTextPdf, assertNoHandlerClones, contextFor, deterministicColorConversionContext,
  cadFixture, pngFixture, printerMarksFixture, psFixture, root, capabilities, coverage,
  effectContracts, handlerIds, assertEffectContract, THEATER_METHODS,
} = setup;

test('convert.images-to-pdf embeds the decoded PNG as a sized DeviceRGB image XObject', async () => {
  const outcome = await deliverProfessionalCapability('convert.images-to-pdf', {
    sourceBytes: pngFixture,
    sourceSha256: createHash('sha256').update(pngFixture).digest('hex'),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.width, 4);
  assert.equal(outcome.height, 4);
  const pdf = outcome.bytes.toString('latin1');
  assert.match(pdf, /\/Subtype \/Image/);
  assert.match(pdf, /\/Width 4 \/Height 4/);
  assert.match(pdf, /\/ColorSpace \/DeviceRGB/);
  assert.match(pdf, /\/Im0 Do/);
});

test('convert.office-to-pdf uses the explicit office body for its local text conversion', async () => {
  const outcome = await deliverProfessionalCapability('convert.office-to-pdf', {
    body: 'office body',
    sourceBytes: createBlankPdf({ pages: 1, title: 'unrelated fallback' }),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.extractedTextLength, 11);
  assert.equal(outcome.bytes.includes(Buffer.from('office body', 'latin1')), true);
  assert.equal(outcome.bytes.includes(Buffer.from('unrelated fallback', 'latin1')), false);
});

test('create.blank-pdf emits the requested bounded page tree and dimensions', async () => {
  const outcome = await deliverProfessionalCapability('create.blank-pdf', {
    pages: 2,
    widthPoints: 320,
    heightPoints: 480,
    title: 'blank fixture',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.pageCount, 2);
  const pdf = outcome.bytes.toString('latin1');
  assert.match(pdf, /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 2/);
  assert.equal((pdf.match(/\/Type \/Page\b/g) ?? []).length, 2);
  assert.match(pdf, /\/MediaBox \[0 0 320 480\]/);
});

test('create.multiformat-combine creates one page for each extracted local source', async () => {
  const outcome = await deliverProfessionalCapability('create.multiformat-combine', {
    sources: [
      { kind: 'text', bytes: Buffer.from('Alpha', 'utf8'), extension: '.txt' },
      { kind: 'html', bytes: Buffer.from('<p>Beta</p>', 'utf8') },
    ],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sourceCount, 2);
  assert.equal(outcome.pageCount, 2);
  const pdf = outcome.bytes.toString('latin1');
  assert.match(pdf, /\/Count 2/);
  assert.equal((pdf.match(/\/Type \/Page\b/g) ?? []).length, 2);
  assert.match(pdf, /Alpha/);
  assert.match(pdf, /Beta/);
});

test('document.download.original returns the exact admitted source without transformation', async () => {
  const sourcePdf = createTextPdf({ text: 'Original bytes', title: 'original fixture' });
  const outcome = await deliverProfessionalCapability('document.download.original', { sourcePdf });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.pdf, sourcePdf);
  assert.equal(outcome.pdf.equals(sourcePdf), true);
  assert.equal(outcome.bytes, sourcePdf.length);
  assert.equal(outcome.outputSha256, outcome.sourceSha256);
});

test('document open paths create source-bound sessions and validate drop names', async () => {
  const sourcePdf = createTextPdf({ text: 'Session source', title: 'session fixture' });
  const local = await deliverProfessionalCapability('document.open.local', { sourcePdf });
  const dropped = await deliverProfessionalCapability('document.open.drag-drop', {
    sourcePdf,
    fileName: 'review.pdf',
  });
  assert.equal(local.open, true);
  assert.equal(dropped.open, true);
  assert.notEqual(local.sessionId, dropped.sessionId);
  assert.equal(local.sourceSha256, dropped.sourceSha256);
  assert.equal(dropped.fileName, 'review.pdf');
  await assert.rejects(
    () => deliverProfessionalCapability('document.open.drag-drop', {
      sourcePdf,
      fileName: '../review.pdf',
    }),
    (error) => error?.code === 'INVALID_DROP_NAME',
  );
  await deliverProfessionalCapability('document.close', { sessionId: local.sessionId });
  await deliverProfessionalCapability('document.close', { sessionId: dropped.sessionId });
});
