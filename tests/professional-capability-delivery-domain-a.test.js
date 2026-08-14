import * as setup from "./support/professional-capability-delivery-test-setup.js";

const {
  assert, createHash, readFileSync, join, test, deliverProfessionalCapability,
  listProfessionalHandlers, getProfessionalHandler, resetAiPolicyForTests,
  validateComparisonPackage, inspectPdfPrinterMarks, createBlankPdf, createTextPdf,
  decodePng, encodeRgbaPng, readZipEntries, redactionFixture,
  editableTextPdf, assertNoHandlerClones, contextFor, deterministicColorConversionContext,
  cadFixture, pngFixture, printerMarksFixture, psFixture, root, capabilities, coverage,
  effectContracts, handlerIds, assertEffectContract, THEATER_METHODS,
} = setup;

test('host-local sandbox probe does not promote the blocked plugin runtime claim', async () => {
  const sandbox = await deliverProfessionalCapability('platform.plugins.runtime-sandbox', contextFor('platform.plugins.runtime-sandbox'));
  assert.equal(sandbox.ok, true);
  assert.equal(sandbox.ready, true);
  assert.equal(sandbox.privateWorkspace, true);
  assert.ok(sandbox.isolation?.privateWorkspace);
  // Honesty: networkOsIsolated may be false when loopback is reachable (ECONNREFUSED).
  assert.equal(typeof sandbox.networkOsIsolated, 'boolean');
  const networkProbe = sandbox.isolation?.networkProbe;
  assert.ok(networkProbe && typeof networkProbe === 'object', 'runtime sandbox must report networkProbe');
  assert.ok(['reachable', 'denied', 'timeout'].includes(networkProbe.status), 'runtime network probe must report reachable, denied, or timeout');
  assert.equal(typeof networkProbe.osIsolated, 'boolean');
  if (networkProbe.status === 'denied') {
    assert.equal(sandbox.networkOsIsolated, true);
    assert.equal(sandbox.isolation.networkOsIsolated, true);
    assert.equal(sandbox.isolation.networkDenied, true);
  } else {
    assert.equal(networkProbe.osIsolated, false);
    assert.equal(sandbox.networkOsIsolated, false);
    assert.equal(sandbox.isolation.networkDenied, false);
  }
  assert.equal(sandbox.networkPolicyDeny, true);
  assert.equal(sandbox.method, 'local-enforced-operation-sandbox');
  assert.equal(capabilities.find((capability) => capability.id === 'platform.plugins.runtime-sandbox')?.delivery, 'planned');
  assert.equal(coverage.records.find((record) => record.id === 'platform.plugins.runtime-sandbox')?.tier, 'blocked');

  const collab = await deliverProfessionalCapability('collaboration.real-time-review', contextFor('collaboration.real-time-review'));
  assert.equal(collab.ok, true);
  assert.equal(collab.synchronized, true);
  assert.ok(collab.observedEvents >= 1);
  assert.ok(collab.session?.id || collab.session?.revision >= 0);
  assert.equal(collab.method, 'local-multi-session-review-sync');

  const dms = await deliverProfessionalCapability('dms.repository-connectors', contextFor('dms.repository-connectors'));
  assert.equal(dms.ok, true);
  assert.equal(dms.connected, true);
  assert.ok(dms.put?.sha256);
  assert.equal(dms.getSha256, dms.put.sha256);
  assert.ok(dms.listCount >= 1);
  assert.equal(dms.method, 'local-filesystem-dms-repository');

  const pdfua = await deliverProfessionalCapability('standards.pdf-ua', contextFor('standards.pdf-ua'));
  assert.equal(pdfua.ok, true);
  assert.equal(pdfua.certified, false);
  assert.ok(pdfua.report?.findings?.length >= 1);
  assert.match(pdfua.method, /pdfua/i);

});

test('sign.certificate fails closed when no production identity service is injected', async () => {
  await assert.rejects(
    () => deliverProfessionalCapability('sign.certificate', contextFor('sign.certificate')),
    { code: 'CERTIFICATE_SIGNATURE_UNAVAILABLE' },
  );
});

test('redaction.apply removes secret page content from the derived PDF', async () => {
  const secret = 'secret';
  const source = redactionFixture({ secret });
  assert.equal(source.includes(Buffer.from(secret, 'latin1')), true);
  const outcome = await deliverProfessionalCapability('redaction.apply', { sourcePdf: source, page: 1, secret });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.secretRemoved, true);
  assert.equal(outcome.pdf.includes(Buffer.from(secret, 'latin1')), false);
  assert.ok(outcome.pdf.includes(Buffer.from('survivor', 'latin1')));
  assert.equal(outcome.method, 'local-object-full-page-redaction');
});

test('security.encryption-aes seals source so plaintext is absent and round-trips', async () => {
  const secret = 'CONFIDENTIAL-PAYLOAD';
  const source = createTextPdf({ text: secret, title: 'Sensitive' });
  const outcome = await deliverProfessionalCapability('security.encryption-aes', {
    sourcePdf: source,
    secret,
    userPassword: 'UserPass12!abc',
    ownerPassword: 'OwnerPass12!xyz',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.plaintextAbsent, true);
  assert.equal(outcome.roundTripOk, true);
  assert.equal(outcome.cipher, 'AES-128-CBC');
  assert.equal(outcome.pdf.includes(Buffer.from(secret, 'utf8')), false);
  assert.notEqual(outcome.sealedSha256, outcome.sourceSha256);
});

test('aec.measurement writes a calibrated measure dictionary with positive SI value', async () => {
  const outcome = await deliverProfessionalCapability('aec.measurement', {});
  assert.equal(outcome.ok, true);
  assert.ok(outcome.siValue > 0);
  assert.equal(outcome.siUnit, 'm');
  assert.ok(Buffer.isBuffer(outcome.pdf));
  assert.ok(outcome.pdf.length > 100);
  assert.ok(outcome.proof);
  assert.equal(outcome.method, 'local-aec-measure-dictionary');
});

test('edit.text performs one equal-length replacement via the production writer', async () => {
  const outcome = await deliverProfessionalCapability('edit.text', {
    sourcePdf: editableTextPdf('hello world'),
    find: 'hello world',
    replace: 'HELLO WORLD',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.replacementCount, 1);
  assert.equal(outcome.pdf.includes(Buffer.from('HELLO WORLD', 'latin1')), true);
  assert.equal(outcome.method, 'local-pdf-text-edit-writer');
});

test('compare.content reports token-level added/deleted stats from production algorithms', async () => {
  const primaryPdf = createTextPdf({ text: 'alpha beta gamma', title: 'Comparison primary' });
  const revisionPdf = createTextPdf({ text: 'alpha delta gamma', title: 'Comparison revision' });
  const outcome = await deliverProfessionalCapability('compare.content', {
    primaryPdf,
    revisionPdf,
    primarySha256: createHash('sha256').update(primaryPdf).digest('hex'),
    revisionSha256: createHash('sha256').update(revisionPdf).digest('hex'),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.changed, true);
  assert.equal(outcome.stats.added, 1);
  assert.equal(outcome.stats.deleted, 1);
  assert.equal(outcome.method, 'bounded-source-bound-pdf-content-comparison');
  assert.equal(outcome.professionalProof, false);
});

test('compare.package creates a source-bound privacy-minimal comparison archive', async () => {
  const primaryPdf = createTextPdf({ text: 'alpha beta gamma', title: 'Comparison primary' });
  const revisionPdf = createTextPdf({ text: 'alpha delta gamma', title: 'Comparison revision' });
  const outcome = await deliverProfessionalCapability('compare.package', {
    primaryPdf,
    revisionPdf,
    primarySha256: createHash('sha256').update(primaryPdf).digest('hex'),
    revisionSha256: createHash('sha256').update(revisionPdf).digest('hex'),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.method, 'local-comparison-package-zip');
  assert.equal(outcome.bytes.subarray(0, 2).toString('ascii'), 'PK');
  const validated = validateComparisonPackage(
    outcome.bytes,
    outcome.sourceDigests.primary,
    outcome.sourceDigests.revision,
  );
  assert.deepEqual([...validated.entries.keys()].sort(), [
    'manifest.json',
    'receipts/content.json',
  ]);
  assert.equal(validated.manifest.sourcePdfsIncluded, false);
  assert.equal(validated.manifest.sources[0].sha256, outcome.sourceDigests.primary);
  assert.equal(validated.manifest.sources[1].sha256, outcome.sourceDigests.revision);
  const receipt = JSON.parse(validated.entries.get('receipts/content.json').toString('utf8'));
  assert.deepEqual(receipt.stats, {
    added: 1,
    changed: 2,
    deleted: 1,
    leftPages: 1,
    rightPages: 1,
    unchanged: 2,
  });
});

test('compare.package rejects unbound text and proves identical PDF content is unchanged', async () => {
  const pdf = createTextPdf({ text: 'alpha beta gamma', title: 'Same comparison source' });
  const sourceDigest = createHash('sha256').update(pdf).digest('hex');
  await assert.rejects(
    () => deliverProfessionalCapability('compare.package', {
      primaryPdf: pdf,
      revisionPdf: Buffer.from(pdf),
      primarySha256: sourceDigest,
      revisionSha256: sourceDigest,
      leftText: 'alpha beta gamma',
      rightText: 'contradictory changed text',
    }),
    (error) => error?.code === 'COMPARISON_UNBOUND_TEXT',
  );

  const outcome = await deliverProfessionalCapability('compare.package', {
    primaryPdf: pdf,
    revisionPdf: Buffer.from(pdf),
    primarySha256: sourceDigest,
    revisionSha256: sourceDigest,
  });
  assert.deepEqual(outcome.sourceDigests, { primary: sourceDigest, revision: sourceDigest });
  const validated = validateComparisonPackage(outcome.bytes, sourceDigest, sourceDigest);
  const receipt = JSON.parse(validated.entries.get('receipts/content.json').toString('utf8'));
  assert.deepEqual(receipt.inputs, [
    { role: 'primary', sha256: sourceDigest },
    { role: 'secondary', sha256: sourceDigest },
  ]);
  assert.deepEqual(receipt.stats, {
    added: 0,
    changed: 0,
    deleted: 0,
    leftPages: 1,
    rightPages: 1,
    unchanged: 3,
  });
  assert.deepEqual(receipt.pages[0].runs, [{ kind: 'unchanged', text: 'alpha beta gamma', count: 3 }]);
});
