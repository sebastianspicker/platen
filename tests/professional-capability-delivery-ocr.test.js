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

test('ocr.cleanup applies a source-bound raster preset without changing the canvas', async () => {
  const outcome = await deliverProfessionalCapability('ocr.cleanup', {
    pngBytes: pngFixture,
    cleanupPreset: 'bilevel',
  });
  assert.equal(outcome.ok, true);
  const before = decodePng(pngFixture);
  const after = decodePng(outcome.bytes);
  assert.equal(after.width, before.width);
  assert.equal(after.height, before.height);
  assert.equal(outcome.receipt.canvasPreserved, true);
  assert.equal(outcome.receipt.beforeSha256, createHash('sha256').update(pngFixture).digest('hex'));
  assert.equal(outcome.receipt.afterSha256, createHash('sha256').update(outcome.bytes).digest('hex'));
  assert.notEqual(outcome.receipt.beforeSha256, outcome.receipt.afterSha256);
  assert.equal(after.pixels.every((value, index) => index % 4 === 3 ? value === 255 : value === 0 || value === 255), true);
  await assert.rejects(
    () => deliverProfessionalCapability('ocr.cleanup', { pngBytes: pngFixture, cleanupPreset: 'unsafe' }),
    (error) => error?.code === 'INVALID_OCR_CLEANUP',
  );
});

test('ocr.editable-output creates a genuine text-only editable DOCX package', async () => {
  const outcome = await deliverProfessionalCapability('ocr.editable-output', {
    text: 'Editable OCR body',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.format, 'word');
  assert.equal(outcome.extension, 'docx');
  assert.equal(outcome.bytes.subarray(0, 2).toString('ascii'), 'PK');
  const entries = readZipEntries(outcome.bytes);
  assert.equal(entries.has('[Content_Types].xml'), true);
  assert.equal(entries.has('word/document.xml'), true);
  assert.match(entries.get('word/document.xml').toString('utf8'), /Editable OCR body/);
  assert.equal(outcome.outputSha256, createHash('sha256').update(outcome.bytes).digest('hex'));
});

test('optimize.fast-web-view delegates to the validated service and fails closed without it', async () => {
  const fixtureContext = contextFor('optimize.fast-web-view');
  const outcome = await deliverProfessionalCapability('optimize.fast-web-view', fixtureContext);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.path, 'validated-qpdf-service');
  assert.equal(outcome.artifactId, 'deterministic-fast-web-view-artifact');
  assert.equal(outcome.sourceDigest, fixtureContext.sourceSha256);
  assert.deepEqual(outcome.engine, { name: 'qpdf', version: 'deterministic-service-fixture' });
  assert.equal(outcome.evidence.deterministicServiceFixture, true);

  await assert.rejects(
    () => deliverProfessionalCapability('optimize.fast-web-view', {
      sourcePdf: createBlankPdf({ pages: 1 }),
    }),
    { code: 'FAST_WEB_VIEW_UNAVAILABLE', status: 503 },
  );
});

test('create.blank-pdf rejects invalid professional inputs', async () => {
  await assert.rejects(
    () => deliverProfessionalCapability('create.blank-pdf', { pages: 0 }),
    (error) => error?.code === 'INVALID_PAGE_COUNT' || error?.code === 'INVALID_CAPABILITY_INPUT' || /page/i.test(error?.message ?? ''),
  );
});

test('AI policy controls keep remote providers denied under local-deterministic policy', async () => {
  resetAiPolicyForTests();
  const deny = await deliverProfessionalCapability('ai.provider-policy-controls', { requestedProvider: 'openai' });
  assert.equal(deny.ok, true);
  const policy = deny.result?.policy ?? deny.policy ?? deny.result;
  assert.ok(policy);
  assert.equal(policy.allowNetwork ?? policy.allowNetworkProviders ?? false, false);
  assert.ok((policy.allowedProviders ?? ['local-deterministic']).includes('local-deterministic'));
});
