import * as setup from "./support/professional-capability-delivery-test-setup.js";
import { Readable } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { createOperationProvenance } from '../scripts/host/operation-provenance.mjs';
import { createProfessionalPrintDelivery } from '../scripts/host/professional-capability/standards-preflight-print-core.mjs';

const {
  assert, createHash, readFileSync, join, test, deliverProfessionalCapability,
  listProfessionalHandlers, getProfessionalHandler, resetAiPolicyForTests,
  validateComparisonPackage, inspectPdfPrinterMarks, createBlankPdf, createTextPdf,
  decodePng, encodeRgbaPng, readZipEntries, redactionFixture, formFixture,
  editableTextPdf, assertNoHandlerClones, contextFor,
  cadFixture, pngFixture, printerMarksFixture, psFixture, root, capabilities, coverage,
  effectContracts, handlerIds, assertEffectContract, assertContract, THEATER_METHODS,
} = setup;

const cmykProfileSha256 = 'b'.repeat(64);
const cmykLimitations = Object.freeze([
  'This is CMYK-targeted normalization through an exact local ICC profile, not PDF/X, GWG, Ghent, or press certification.',
  'Ghostscript does not colorimetrically retarget existing DeviceCMYK values; Separation and DeviceN colorants are preserved rather than eliminated.',
  'No PDF OutputIntent is assigned or validated, and complex transparency, optional content, annotations, links, and metadata may be rewritten.',
]);

async function colorConversionDelivery(t, sourcePdf, displayName) {
  const directory = await mkdtemp(join(tmpdir(), 'platen-color-delivery-'));
  const store = await new DocumentStore({ root: directory }).initialize();
  t.after(() => store.dispose());
  const source = await store.createDocument({ stream: Readable.from([sourcePdf]), displayName });
  const workspace = await store.createJobWorkspace(source.id);
  const outputPath = join(workspace, 'cmyk.pdf');
  await writeFile(outputPath, sourcePdf);
  const outputSha256 = createHash('sha256').update(sourcePdf).digest('hex');
  const operation = createOperationProvenance({
    type: 'ghostscript-icc-cmyk',
    inputs: [{ documentId: source.id, sha256: source.sha256, role: 'source' }],
    parameters: {
      profileId: 'ghostscript-default-cmyk', profileSha256: cmykProfileSha256,
      renderingIntent: 'relative-colorimetric', blackPointCompensation: true,
      preserveSeparations: true, overrideEmbeddedIcc: false,
    },
    expected: { pageCount: 1, outputColorSpace: 'CMYK-targeted', rasterized: false },
    validation: {
      passed: true, outputSha256, pageCount: 1, textSha256: source.sha256,
      validators: [
        'source-sha256', 'icc-header-and-tags', 'icc-profile-sha256',
        'ghostscript-exit-zero', 'poppler-page-count', 'poppler-page-boxes',
        'poppler-passive-content', 'poppler-text-equivalence',
        'poppler-render-all-pages', 'artifact-sha256',
      ],
    },
  });
  const artifact = await store.promotePdfArtifact(source.id, outputPath, {
    displayName: 'cmyk.pdf', operation, expectedSha256: outputSha256,
  });
  await store.cleanupJob(workspace);
  const calls = [];
  const prepress = Object.freeze({
    async convertToCmyk(documentId, options) {
      calls.push(Object.freeze({ documentId, options: Object.freeze({ ...options }) }));
      return Object.freeze({
        kind: 'icc-cmyk-artifact', schemaVersion: 1, sourceDigest: source.sha256, artifact,
        profile: Object.freeze({ id: 'ghostscript-default-cmyk', colorSpace: 'CMYK', sha256: cmykProfileSha256 }),
        recipe: Object.freeze({ colorConversionStrategy: 'CMYK' }),
        receipt: Object.freeze({
          outputSha256, pageCount: 1, pageGeometryPreserved: true, textExtractionEquivalent: true,
          everyPageRendered: true, outputIntentEmbeddedOrValidated: false, pdfXValidated: false,
        }),
        authoritative: false, limitations: cmykLimitations,
        serviceEvidence: Object.freeze({ deterministicServiceFixture: true, ghostscriptExecuted: false }),
      });
    },
  });
  const professional = createProfessionalPrintDelivery({
    store, services: { prepress }, deliver: deliverProfessionalCapability, list: listProfessionalHandlers,
  });
  return Object.freeze({
    calls, professional, context: Object.freeze({ documentId: source.id, sourceSha256: source.sha256, profile: 'ghostscript-default-cmyk' }),
  });
}

test('batch slip sheets create one replacement page per source and carry markup data', async () => {
  const outcome = await deliverProfessionalCapability('aec.batch-slip-sheet', {
    slips: [
      { page: 4, note: 'Superseded by A-104', markups: ['RFI-7', { type: 'revision-cloud' }] },
      { page: 9, note: 'Superseded by A-109', markups: [{ text: 'Door note' }] },
    ],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.replacementSheetsCreated, true);
  assert.equal(outcome.pageCount, 2);
  assert.equal(outcome.carriedMarkupCount, 3);
  assert.deepEqual(outcome.replacementPages, [
    { outputPage: 1, sourcePage: 4, carriedMarkupCount: 2 },
    { outputPage: 2, sourcePage: 9, carriedMarkupCount: 1 },
  ]);
  assert.equal(outcome.bytes, outcome.pdf.length);
  const pdf = outcome.pdf.toString('latin1');
  assert.match(pdf, /\/Count 2/u);
  assert.match(pdf, /SOURCE-PAGE:4/u);
  assert.match(pdf, /CARRIED-MARKUP:RFI-7/u);
  assert.match(pdf, /SOURCE-PAGE:9/u);
  assert.match(pdf, /CARRIED-MARKUP:Door note/u);
});

test('root-only print delivery rejects direct generic dispatch', async () => {
  await assert.rejects(
    () => deliverProfessionalCapability('print.bleed-marks', { sourcePdf: printerMarksFixture, bleedPoints: 9, markPages: [1] }),
    { code: 'INVALID_PRODUCTION_AUTHORITY', status: 503 },
  );
});

test('print.imposition requires the composition-root authority', async () => {
  const fixtureContext = contextFor('print.imposition');
  await assert.rejects(
    () => deliverProfessionalCapability('print.imposition', fixtureContext),
    { code: 'INVALID_PRODUCTION_AUTHORITY', status: 503 },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('print.imposition', {
      ...fixtureContext,
      marks: true,
    }),
    { code: 'PRINTER_MARKS_UNSUPPORTED', status: 422 },
  );
});

test('transparency flattening requires the composition-root authority', async () => {
  const fixtureContext = contextFor('print.transparency-flattening');
  await assert.rejects(
    () => deliverProfessionalCapability('print.transparency-flattening', fixtureContext),
    { code: 'INVALID_PRODUCTION_AUTHORITY', status: 503 },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('print.transparency-flattening', {
      ...fixtureContext,
      quality: 'high',
    }),
    { code: 'UNSUPPORTED_TRANSPARENCY_QUALITY', status: 422 },
  );
});

test('annotation flattening delegates to the source-bound service and rejects receipt drift', async () => {
  const fixtureContext = contextFor('review.annotation-flatten');
  const outcome = await deliverProfessionalCapability('review.annotation-flatten', fixtureContext);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.method, 'validated-square-annotation-flatten-service');
  assert.equal(outcome.sourceDigest, fixtureContext.sourceSha256);
  assert.equal(outcome.artifactId, 'deterministic-annotation-flatten-artifact');
  assert.equal(outcome.evidence.appearancePromotedToPageContent, true);
  assert.equal(outcome.evidence.annotationRemoved, true);

  await assert.rejects(
    () => deliverProfessionalCapability('review.annotation-flatten', {
      sourcePdf: createBlankPdf({ pages: 1 }),
    }),
    { code: 'ANNOTATION_FLATTEN_UNAVAILABLE', status: 503 },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('review.annotation-flatten', {
      ...fixtureContext,
      annotationFlatten: {
        flatten: async (...args) => ({
          ...await fixtureContext.annotationFlatten.flatten(...args),
          sourceDigest: '0'.repeat(64),
        }),
      },
    }),
    { code: 'ANNOTATION_FLATTEN_OUTPUT_INVALID', status: 502 },
  );
});

test('color conversion binds the fixed CMYK service to source identity and fails closed', async (t) => {
  const firstFixture = await colorConversionDelivery(t,
    createTextPdf({ text: 'FIRST COLOR SOURCE', title: 'First' }),
    'first.pdf',
  );
  const secondFixture = await colorConversionDelivery(t,
    createTextPdf({ text: 'SECOND COLOR SOURCE', title: 'Second' }),
    'second.pdf',
  );
  const first = await firstFixture.professional.deliver('color.convert', firstFixture.context);
  const second = await secondFixture.professional.deliver('color.convert', secondFixture.context);

  assert.equal(first.ok, true);
  assert.equal(first.method, 'validated-prepress-cmyk-service');
  assert.equal(first.targetProfile, 'ghostscript-default-cmyk');
  assert.equal(first.profile.colorSpace, 'CMYK');
  assert.equal(first.sourceSha256, firstFixture.context.sourceSha256);
  assert.equal(first.serviceEvidence.deterministicServiceFixture, true);
  assert.equal(first.serviceEvidence.ghostscriptExecuted, false);
  assert.deepEqual(firstFixture.calls.map((call) => ({
    documentId: call.documentId,
    profile: call.options.profile,
  })), [{
    documentId: firstFixture.context.documentId,
    profile: 'ghostscript-default-cmyk',
  }]);
  assert.notEqual(first.sourceSha256, second.sourceSha256);
  assert.notEqual(first.outputSha256, second.outputSha256);

  await assert.rejects(
    () => deliverProfessionalCapability('color.convert', {
      documentId: firstFixture.context.documentId,
      sourceSha256: firstFixture.context.sourceSha256,
      profile: 'ghostscript-default-cmyk',
    }),
    { code: 'INVALID_PRODUCTION_AUTHORITY', status: 503 },
  );
  await assert.rejects(
    () => deliverProfessionalCapability('color.convert', {
      ...firstFixture.context,
      profile: 'sRGB',
    }),
    { code: 'INVALID_ICC_PROFILE', status: 400 },
  );
});

test('pdfMustContain predicates fail closed on missing PDF markers', () => {
  const theaterOutcome = {
    ok: true,
    capabilityId: 'viewer.bookmarks',
    method: 'local-classic-pdf-outlines',
    outlineApplied: true,
    pdf: Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1'),
  };
  const table = {
    contracts: {
      'viewer.bookmarks': {
        claimClass: 'mutation',
        requiredKeys: ['method', 'pdf'],
        method: 'local-classic-pdf-outlines',
        requirePdf: true,
        pdfMustContain: ['/Outlines'],
        equals: { outlineApplied: true },
      },
    },
  };
  assert.throws(
    () => assertContract(assert, table, 'viewer.bookmarks', theaterOutcome),
    /missing required marker|Outlines/,
  );
});
