import * as setup from './support/professional-capability-delivery-test-setup.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAccessibilityFormSemanticsService } from '../scripts/host/pdf-accessibility-form-semantics-service.mjs';
import { makeButtonWidgetPdf } from './host-pdfkit-test-fixtures-b.js';
import { productionArtifact, productionReceipt } from './support/professional-capability-delivery-accessibility-support.js';
const { assert, createHash, test, deliverProfessionalCapability, createBlankPdf } = setup;

test('document language/title capability writes normalized PDF metadata', async () => {
  const outcome = await deliverProfessionalCapability('accessibility.document-language-title', {
    lang: 'EN-Latn-US',
    title: 'Accessible PDF',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.lang, 'en-latn-us');
  assert.equal(outcome.title, 'Accessible PDF');
  assert.equal(outcome.proof.sourcePrefixPreserved, true);
  const pdf = outcome.pdf.toString('latin1');
  assert.match(pdf, /\/Lang <FEFF0065006E002D006C00610074006E002D00750073>/u);
  assert.match(pdf, /\/Title <FEFF00410063006300650073007300690062006C00650020005000440046>/u);
});

test('form semantics capability applies names, tooltips, and structural tab order', async () => {
  const outcome = await deliverProfessionalCapability('accessibility.form-semantics', {
    demoFixture: true,
    fields: [
      { name: 'Email', role: 'Tx', tooltip: 'Email address', required: true, tabIndex: 1 },
      { name: 'Consent', role: 'Btn', tooltip: 'Accept terms', required: false, tabIndex: 0 },
    ],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.proof.namesAndTooltipsBound, true);
  assert.equal(outcome.proof.tabOrder, 'S');
  assert.equal(outcome.proof.sourcePrefixPreserved, true);
  assert.deepEqual(outcome.proof.orderedWidgetObjects.map((entry) => entry.object), [6, 5]);
  const pdf = outcome.pdf.toString('latin1');
  assert.match(pdf, /\/Tabs \/S/u);
  assert.match(pdf, /\/T <FEFF0045006D00610069006C>/u);
  assert.match(pdf, /\/TU <FEFF0041006300630065007000740020007400650072006D0073>/u);
});

test('accessibility repair uses the supplied source and exact source-bound request', async () => {
  const fields = [
    { name: 'Email', role: 'Tx', tooltip: 'Email address', required: true, tabIndex: 0 },
  ];
  const demo = await deliverProfessionalCapability('accessibility.form-semantics', {
    demoFixture: true,
    fields,
  });
  const sourcePdf = Buffer.from(demo.pdf.subarray(0, demo.sourceByteLength));
  const sourceSha256 = createHash('sha256').update(sourcePdf).digest('hex');
  const documentId = 'form-document';
  const artifact = productionArtifact({
    id: '11111111-1111-4111-8111-111111111111',
    documentId,
    sourceSha256,
    bytes: demo.pdf,
    operationType: 'pdf-accessibility-form-semantics',
  });
  const receipt = productionReceipt('pdf-accessibility-form-semantics', artifact, demo.proof);
  const outcome = await deliverProfessionalCapability('accessibility.form-semantics', {
    documentId,
    sourcePdf,
    sourceSha256,
    formRequest: demo.repairRequest,
    accessibilityFormSemantics: {
      async repair(actualDocumentId, request) {
        assert.equal(actualDocumentId, documentId);
        assert.equal(request, demo.repairRequest);
        return receipt;
      },
    },
    async readArtifact(actualArtifact) {
      assert.equal(actualArtifact, artifact);
      return Buffer.from(demo.pdf);
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.demoFixtureUsed, false);
  assert.equal(outcome.professionalProof, true);
  assert.equal(outcome.serviceReceipt, receipt);
  assert.deepEqual(outcome.trustBoundary, {
    productionService: true,
    immutableSourceDigest: true,
    artifactReread: true,
    independentSemanticInspection: true,
  });
  assert.equal(outcome.sourceSha256, sourceSha256);
  assert.equal(outcome.proof.sourceSha256, outcome.sourceSha256);
  assert.equal(outcome.proof.sourcePrefixPreserved, true);
  assert.equal(outcome.pdf.subarray(0, sourcePdf.length).equals(sourcePdf), true);
});

test('form semantics professional boundary retains and validates a real production-service artifact', async (t) => {
  const root = await mkdtemp('/private/tmp/professional-accessibility-form-');
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const sourcePdf = makeButtonWidgetPdf();
  const sourceSha256 = createHash('sha256').update(sourcePdf).digest('hex');
  const source = await store.createDocument({
    stream: (async function* stream() { yield sourcePdf; }()),
    displayName: 'source.pdf',
  });
  const formRequest = {
    profile: 'local-accessibility-form-semantics-v1',
    sourceSha256,
    fields: [0, 1, 2].map((annotationIndex, tabIndex) => ({
      target: {
        page: 1,
        annotationIndex,
        fingerprint: createHash('sha256').update(Buffer.from([
          'pdfkit-inspector:opaque-locator:v1', `source-sha256=${sourceSha256}`,
          'page=1', `annotation-index=${annotationIndex}`, 'subtype=widget', 'widget-type=button',
        ].join('\n'))).digest('hex'),
      },
      role: 'button',
      name: `Field ${annotationIndex}`,
      tooltip: `Field tooltip ${annotationIndex}`,
      tabIndex,
    })),
  };
  const outcome = await deliverProfessionalCapability('accessibility.form-semantics', {
    documentId: source.id,
    sourcePdf,
    sourceSha256,
    formRequest,
    accessibilityFormSemantics: new PdfAccessibilityFormSemanticsService({ store }),
    async readArtifact(artifact) {
      return readFile(store.getArtifact(artifact.id).filePath);
    },
  });
  assert.equal(outcome.professionalProof, true);
  assert.equal(outcome.serviceReceipt.kind, 'pdf-accessibility-form-semantics');
  assert.equal(outcome.artifact.documentId, source.id);
  assert.equal(outcome.outputSha256, outcome.artifact.sha256);
  assert.equal(outcome.proof.fieldCount, 3);
  assert.equal(outcome.proof.namesAndTooltipsBound, true);
});

test('accessibility repairs reject supplied sources without their exact request contract', async () => {
  const sourcePdf = createBlankPdf({ pages: 1, title: 'must not be discarded' });
  for (const id of [
    'accessibility.form-semantics',
    'accessibility.links-bookmarks',
    'accessibility.table-semantics',
  ]) {
    await assert.rejects(
      () => deliverProfessionalCapability(id, { sourcePdf, demoFixture: true }),
      (error) => [
        'ACCESSIBILITY_REPAIR_REQUEST_REQUIRED',
        'ACCESSIBILITY_FORM_REQUEST_REQUIRED',
        'ACCESSIBILITY_LINKS_REQUEST_REQUIRED',
        'ACCESSIBILITY_TABLE_REQUEST_REQUIRED',
        'SOURCE_VERSION_MISMATCH',
      ].includes(error?.code),
      id,
    );
  }
});
