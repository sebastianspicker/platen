import * as setup from './support/professional-capability-delivery-test-setup.js';
import { productionArtifact, productionReceipt } from './support/professional-capability-delivery-accessibility-support.js';
const { assert, createHash, test, deliverProfessionalCapability, createBlankPdf } = setup;

test('links/bookmarks capability applies purpose, title, and destinations', async () => {
  const outcome = await deliverProfessionalCapability('accessibility.links-bookmarks', {
    demoFixture: true,
    links: [{ text: 'Details', purpose: 'Read details', page: 3 }],
    bookmarks: [{ title: 'Summary', page: 2 }],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.proof.links[0].targetPage, 3);
  assert.equal(outcome.proof.bookmarks[0].targetPage, 2);
  assert.equal(outcome.proof.sourcePrefixPreserved, true);
  assert.equal(outcome.proof.hierarchyPreserved, true);
  assert.equal(outcome.proof.updatedObjectNumbers.length, 2);
  const pdf = outcome.pdf.toString('latin1');
  assert.match(pdf, /\/Contents <FEFF0052006500610064002000640065007400610069006C0073>/u);
  assert.match(pdf, /\/Title <FEFF00530075006D006D006100720079>/u);
  assert.match(pdf, /\/Dest \[5 0 R \/Fit\]/u);
  assert.match(pdf, /\/Dest \[4 0 R \/Fit\]/u);
});

test('links/bookmarks production path rereads and independently validates the promoted artifact', async () => {
  const demo = await deliverProfessionalCapability('accessibility.links-bookmarks', {
    demoFixture: true,
    links: [{ text: 'Details', purpose: 'Read details', page: 3 }],
    bookmarks: [{ title: 'Summary', page: 2 }],
  });
  const sourcePdf = Buffer.from(demo.pdf.subarray(0, demo.sourceByteLength));
  const sourceSha256 = createHash('sha256').update(sourcePdf).digest('hex');
  const documentId = 'links-document';
  const artifact = productionArtifact({
    id: '22222222-2222-4222-8222-222222222222', documentId, sourceSha256,
    bytes: demo.pdf, operationType: 'pdf-accessibility-links-bookmarks',
  });
  const receipt = Object.freeze({
    kind: 'pdf-accessibility-links-bookmarks',
    sourceDigest: sourceSha256,
    artifact,
    operation: artifact.operation,
    evidence: Object.freeze({ localOnly: true, sourceUnchanged: true, artifactDigestBound: true }),
    limitations: Object.freeze(['Bounded classic direct-link and outline subset.']),
  });
  const outcome = await deliverProfessionalCapability('accessibility.links-bookmarks', {
    documentId, sourcePdf, sourceSha256, linksRequest: demo.repairRequest,
    accessibilityLinksBookmarks: { async update() { return receipt; } },
    async readArtifact() { return Buffer.from(demo.pdf); },
  });
  assert.equal(outcome.professionalProof, true);
  assert.equal(outcome.serviceReceipt, receipt);
  assert.equal(outcome.outputSha256, artifact.sha256);
  assert.equal(outcome.proof.sourcePrefixPreserved, true);
  assert.equal(outcome.trustBoundary.artifactReread, true);
});

test('screen-reader permission check trusts the final xref, not decoy PDF text', async () => {
  const source = createBlankPdf({ title: '/Encrypt 9 0 R /P -3904' });
  const outcome = await deliverProfessionalCapability('accessibility.screen-reader-permissions', {
    sourcePdf: source,
    accessibility: false,
    copy: false,
    print: false,
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.permissions, {
    extractText: true,
    accessibility: true,
    copy: true,
    print: true,
    encrypted: false,
  });
  assert.equal(outcome.screenReaderFriendly, true);
  assert.equal(outcome.evidence.inspector, 'classic-final-xref-unencrypted');
  assert.equal(outcome.evidence.sourceBound, true);
  assert.equal(outcome.evidence.finalXrefInspected, true);
  assert.match(outcome.sourceSha256, /^[0-9a-f]{64}$/u);
});

test('table semantics capability repairs scope and header associations', async () => {
  const outcome = await deliverProfessionalCapability('accessibility.table-semantics', {
    demoFixture: true,
    headers: ['Name', 'Value'],
    rows: [['Alpha', '1']],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.structureLinked, true);
  assert.equal(outcome.proof.rowCount, 2);
  assert.equal(outcome.proof.columnCount, 2);
  assert.equal(outcome.proof.cellCount, 4);
  assert.equal(outcome.proof.contentStreamsUnchanged, true);
  assert.equal(outcome.proof.sourcePrefixPreserved, true);
  const pdf = outcome.pdf.toString('latin1');
  assert.match(pdf, /\/Scope \/Column/u);
  assert.match(pdf, /\/Headers \[<FEFF00680030>\]/u);
  assert.match(pdf, /\/ID <FEFF00680030>/u);
  assert.match(pdf, /\/ColSpan 1/u);
  assert.match(pdf, /\/RowSpan 1/u);
});

test('table semantics production path rereads and independently validates the promoted artifact', async () => {
  const demo = await deliverProfessionalCapability('accessibility.table-semantics', {
    demoFixture: true,
    headers: ['Name', 'Value'],
    rows: [['Alpha', '1']],
  });
  const sourcePdf = Buffer.from(demo.pdf.subarray(0, demo.sourceByteLength));
  const sourceSha256 = createHash('sha256').update(sourcePdf).digest('hex');
  const documentId = 'table-document';
  const artifact = productionArtifact({
    id: '33333333-3333-4333-8333-333333333333', documentId, sourceSha256,
    bytes: demo.pdf, operationType: 'pdf-accessibility-table-semantics',
  });
  const receipt = productionReceipt('pdf-accessibility-table-semantics', artifact, demo.proof);
  const outcome = await deliverProfessionalCapability('accessibility.table-semantics', {
    documentId, sourcePdf, sourceSha256, tableRequest: demo.repairRequest,
    accessibilityTableSemantics: { async repair() { return receipt; } },
    async readArtifact() { return Buffer.from(demo.pdf); },
  });
  assert.equal(outcome.professionalProof, true);
  assert.equal(outcome.serviceReceipt, receipt);
  assert.equal(outcome.outputSha256, artifact.sha256);
  assert.equal(outcome.proof.structureLinked, true);
  assert.equal(outcome.trustBoundary.independentSemanticInspection, true);
});

test('production accessibility repairs fail closed on source, receipt, and artifact tampering', async () => {
  const demo = await deliverProfessionalCapability('accessibility.form-semantics', {
    demoFixture: true,
    fields: [{ name: 'Email', role: 'Tx', tooltip: 'Email address', tabIndex: 0 }],
  });
  const sourcePdf = Buffer.from(demo.pdf.subarray(0, demo.sourceByteLength));
  const sourceSha256 = createHash('sha256').update(sourcePdf).digest('hex');
  const documentId = 'tamper-document';
  const artifact = productionArtifact({
    id: '44444444-4444-4444-8444-444444444444', documentId, sourceSha256,
    bytes: demo.pdf, operationType: 'pdf-accessibility-form-semantics',
  });
  const receipt = productionReceipt('pdf-accessibility-form-semantics', artifact, demo.proof);
  const base = {
    documentId, sourcePdf, sourceSha256, formRequest: demo.repairRequest,
    accessibilityFormSemantics: { async repair() { return receipt; } },
    async readArtifact() { return Buffer.from(demo.pdf); },
  };
  await assert.rejects(
    () => deliverProfessionalCapability('accessibility.form-semantics', { ...base, sourceSha256: '0'.repeat(64) }),
    (error) => error?.code === 'SOURCE_VERSION_MISMATCH' && error?.status === 409,
  );
  await assert.rejects(
    () => deliverProfessionalCapability('accessibility.form-semantics', {
      ...base,
      accessibilityFormSemantics: {
        async repair() { return { ...receipt, artifact: { ...artifact, documentId: 'other-document' } }; },
      },
    }),
    (error) => error?.code === 'ACCESSIBILITY_FORM_RECEIPT_INVALID' && error?.status === 502,
  );
  await assert.rejects(
    () => deliverProfessionalCapability('accessibility.form-semantics', {
      ...base,
      async readArtifact() { return Buffer.concat([demo.pdf, Buffer.from('tamper')]); },
    }),
    (error) => error?.code === 'ACCESSIBILITY_FORM_RECEIPT_INVALID' && error?.status === 502,
  );
  await assert.rejects(
    () => deliverProfessionalCapability('accessibility.form-semantics', {
      ...base,
      accessibilityFormSemantics: { async repair() { throw new Error('boom'); } },
    }),
    (error) => error?.code === 'ACCESSIBILITY_FORM_SERVICE_FAILED' && error?.status === 502,
  );
});
