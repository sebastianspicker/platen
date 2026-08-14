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

const proofs = JSON.parse(readFileSync(join(root, 'catalog/capability-proofs/proofs.json'), 'utf8')).records;
const proofById = new Map(proofs.map((record) => [record.capabilityId, record]));
const implementedIds = capabilities
  .filter(({ delivery, evidence }) => delivery === 'implemented'
    && evidence?.reference === 'tests/professional-capability-delivery.test.js')
  .map(({ id }) => id)
  .sort();
const dedicatedSourceBoundIds = Object.freeze([
  'admin.audit-telemetry',
  'automation.api',
  'automation.cli-batch',
  'convert.html-to-pdf',
  'create.cad-to-pdf',
  'create.clipboard-to-pdf',
  'create.postscript-to-pdf',
  'create.print-to-pdf',
  'accessibility.check',
  'accessibility.report-export',
  'accessibility.alt-text',
  'accessibility.artifact-management',
  'accessibility.font-unicode-mapping',
  'accessibility.heading-list-structure',
  'accessibility.reading-order',
  'accessibility.remediate-tags',
  'compare.annotations',
  'compare.batch',
  'compare.overlay',
  'compare.pixel',
  'compare.side-by-side',
  'document.attachments-manage',
  'document.backgrounds',
  'document.bates-numbering',
  'document.bookmarks-author',
  'document.destinations-author',
  'document.embedded-files',
  'document.layers-manage',
  'document.watermarks',
  'edit.add-text',
  'edit.images',
  'edit.object-properties',
  'edit.text-reflow',
  'edit.vector-objects',
  'export.html-xml',
  'export.images',
  'export.excel',
  'export.powerpoint',
  'export.selected-region',
  'export.text-rtf',
  'export.word',
  'forms.author',
  'forms.detect-fields',
  'forms.fill-save',
  'forms.import-export-data',
  'forms.javascript-actions',
  'forms.static-to-fillable',
  'forms.validate',
  'forms.xfa-compatibility',
  'ocr.batch-recognition',
  'ocr.export-layout-preserving',
  'ocr.language-detection-selection',
  'ocr.recognize-text',
  'ocr.screenshot-capture',
  'ocr.table-recognition',
  'ocr.zones-layout',
  'optimize.compress',
  'platform.plugins.dependency-resolution',
  'platform.plugins.install',
  'platform.plugins.lifecycle',
  'platform.plugins.registry',
  'platform.plugins.upgrade-rollback',
  'review.annotation-properties',
  'review.comments-to-office',
  'review.comments',
  'review.annotation-import-export',
  'review.drawing-markup',
  'review.file-audio-attachments',
  'review.measurements',
  'review.notifications-mentions',
  'review.shared-review',
  'review.statuses',
  'review.filter-sort',
  'review.comment-summary',
  'review.review-tracking',
  'review.markup-tools',
  'review.text-markup',
  'review.text-notes-callouts',
  'sign.electronic',
  'sign.validate-certificate',
  'redaction.batch',
  'redaction.find-patterns',
  'redaction.overlay-labels',
  'redaction.preview',
  'sanitize.selective-content',
]);

test('R02 dedicated commands cannot fall back through the generic host dispatcher', async () => {
  for (const capabilityId of [
    'create.postscript-to-pdf',
    'create.print-to-pdf',
    'export.text-rtf',
    'export.html-xml',
    'export.images',
    'optimize.compress',
  ]) {
    assert.throws(
      () => getProfessionalHandler(capabilityId),
      { code: 'PROFESSIONAL_DEDICATED_CAPABILITY_ENTRYPOINT' },
    );
    await assert.rejects(
      () => deliverProfessionalCapability(capabilityId, contextFor(capabilityId)),
      { code: 'PROFESSIONAL_DEDICATED_CAPABILITY_ENTRYPOINT' },
    );
  }
});

test('professional handlers cover proven catalog capabilities that use this evidence file', () => {
  const evidenceIds = capabilities
    .filter((c) => c.evidence?.reference === 'tests/professional-capability-delivery.test.js')
    .map((c) => c.id)
    .sort();
  assert.ok(evidenceIds.length > 0, 'at least one proven capability uses the shared delivery evidence');
  for (const id of evidenceIds) {
    assert.equal(typeof getProfessionalHandler(id), 'function', `${id} has a production handler`);
  }
});

test('professional delivery follows the proof ledger and the runtime sandbox remains blocked', () => {
  assert.equal(capabilities.length, 318);
  const sandbox = capabilities.find((capability) => capability.id === 'platform.plugins.runtime-sandbox');
  assert.deepEqual(sandbox, {
    id: 'platform.plugins.runtime-sandbox',
    familyId: 'plugin-platform',
    owner: 'plugin-platform',
    delivery: 'planned',
    title: 'Runtime sandbox',
    description: 'Enforce a production runtime sandbox for executable plugins.',
    engine: null,
    evidence: null,
  });
  assert.equal(capabilities.filter((c) => c.delivery === 'planned').length, proofs.filter(({ status }) => status !== 'proven').length);
  assert.equal(capabilities.filter((c) => c.delivery === 'implemented').length, proofs.filter(({ status }) => status === 'proven').length);
  for (const capability of capabilities) {
    assert.equal(
      capability.delivery,
      proofById.get(capability.id)?.status === 'proven' ? 'implemented' : 'planned',
      `${capability.id} delivery follows proof status`,
    );
  }
  for (const capability of capabilities.filter((c) => c.delivery === 'implemented')) {
    assert.match(capability.evidence?.kind ?? '', /test/);
    assert.match(capability.evidence.reference, /\S/);
  }
  assert.deepEqual(coverage.records.find((record) => record.id === sandbox.id), {
    id: sandbox.id,
    delivery: 'planned',
    tier: 'blocked',
  });
});

test('professional handler bodies are not rename-theater clones', () => {
  assertNoHandlerClones();
});

test('effect contracts cover every professional handler id', () => {
  assert.ok(effectContracts.schemaVersion >= 1);
  for (const id of handlerIds) {
    const contract = effectContracts.contracts[id];
    assert.ok(contract, `missing effect contract for ${id}`);
    assert.ok(
      Array.isArray(contract.requiredKeys) && contract.requiredKeys.length >= 1,
      `${id} contract requires keys`,
    );
    const forbidden = new Set(['ok', 'localOnly', 'kind', 'schemaVersion', 'capabilityId', 'familyId']);
    const eqKeys = Object.keys(contract.equals ?? {}).filter((k) => !forbidden.has(k));
    assert.equal(eqKeys.includes('ok'), false, `${id} must not use equals.ok`);
    if (contract.equals?.proposedNotApplied === true) {
      assert.fail(`${id} must not pin proposedNotApplied:true`);
    }
    if (typeof contract.method === 'string') {
      const inventoryTheater = /inventory/i.test(contract.method)
        && !/^(?:validated|production)-/i.test(contract.method);
      if (/proposal|stub|probe|descriptor/i.test(contract.method) || inventoryTheater) {
        assert.fail(`${id} method looks like theater: ${contract.method}`);
      }
    }
    if (contract.claimClass === 'mutation' || contract.mutation === true) {
      const structural = (contract.pdfMustContain && contract.pdfMustContain.length)
        || (contract.pdfMustMatch && contract.pdfMustMatch.length)
        || (contract.pdfMustNotContain && contract.pdfMustNotContain.length);
      assert.ok(structural, `${id} mutation claim lacks pdfMustContain/pdfMustMatch/pdfMustNotContain`);
    }
    const hasDomain =
      eqKeys.length > 0
      || (contract.min && Object.keys(contract.min).length > 0)
      || contract.requirePdf === true
      || contract.requireBytes === true;
    assert.ok(hasDomain, `${id} contract lacks non-tautological domain assert`);
  }
  assert.equal(Object.keys(effectContracts.contracts).length, handlerIds.length);
});

test('every proven handler using the shared delivery evidence passes its deterministic fixture', async () => {
  resetAiPolicyForTests();
  let delivered = 0;
  for (const id of implementedIds) {
    const outcome = await deliverProfessionalCapability(id, contextFor(id));
    assert.equal(outcome.ok, true, `${id} ok`);
    assert.equal(outcome.capabilityId, id, `${id} capabilityId`);
    // Real domain evidence: method string, or create-convert path, or concrete artifact fields.
    const hasMethod = typeof outcome.method === 'string' && outcome.method.length > 0;
    const hasPath = typeof outcome.path === 'string' && outcome.path.length > 0;
    const hasArtifact = Buffer.isBuffer(outcome.pdf) || Buffer.isBuffer(outcome.bytes)
      || outcome.report || outcome.job || outcome.session || outcome.config || outcome.viewState
      || outcome.annotation || outcome.inventory || outcome.connector || outcome.status
      || outcome.evidence || outcome.project || outcome.lock || outcome.chain || outcome.summary
      || outcome.devices || outcome.checks || outcome.proposal || outcome.tags || outcome.permissions
      || outcome.synchronized || outcome.ready || outcome.connected || outcome.search
      || outcome.isolation || outcome.put || outcome.plan || outcome.sequence
      || outcome.thumbnails || outcome.outline || outcome.selection || outcome.ratio
      || outcome.ops || outcome.props || outcome.grid || outcome.suspects
      || outcome.coverage || outcome.plates || outcome.records || outcome.chain;
    assert.ok(hasMethod || hasPath || hasArtifact, `${id} missing domain method/path/artifact: ${Object.keys(outcome)}`);
    if (hasMethod) {
      assert.equal(THEATER_METHODS.has(outcome.method), false, `${id} uses banned theater method ${outcome.method}`);
    }
    // Reject pure applied-local workspace receipts without domain evidence.
    if (outcome.record?.status === 'applied-local' && !hasArtifact && !hasPath) {
      assert.fail(`${id} returned applied-local receipt without domain artifact`);
    }
    if (outcome.grant?.allowed === true && !outcome.job && !outcome.status && !outcome.record && !hasArtifact) {
      assert.fail(`${id} returned bare grant:{allowed:true} theater`);
    }
    // ready:false is not professional success for sandbox claims
    if (Object.hasOwn(outcome, 'ready')) {
      assert.equal(outcome.ready, true, `${id} returned ready:false`);
    }
    assertEffectContract(id, outcome);
    delivered += 1;
  }
  assert.equal(delivered, implementedIds.length);
  assert.equal(handlerIds.length, capabilities.length - dedicatedSourceBoundIds.length,
    `expected generic handlers only for non-dedicated capabilities, got ${handlerIds.length}`);
  for (const id of dedicatedSourceBoundIds) {
    assert.equal(handlerIds.includes(id), false, `${id} must not retain a source-dropping generic handler`);
  }
  const implementedEvidenceIds = capabilities
    .filter((c) => c.evidence?.reference === 'tests/professional-capability-delivery.test.js')
    .map((c) => c.id);
  for (const id of implementedEvidenceIds) {
    if (dedicatedSourceBoundIds.includes(id)) continue;
    assert.ok(handlerIds.includes(id), `missing handler for ${id}`);
  }
});
