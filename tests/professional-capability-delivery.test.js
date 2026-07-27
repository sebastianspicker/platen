import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deliverProfessionalCapability,
  listProfessionalHandlers,
  getProfessionalHandler,
} from '../scripts/host/professional-capability/index.mjs';
import { resetAiPolicyForTests } from '../scripts/host/professional-capability/local-ai.mjs';
import { createBlankPdf, createTextPdf } from '../scripts/host/pdf-factory.mjs';
import {
  redactionFixture,
  formFixture,
  editableTextPdf,
} from '../scripts/host/professional-capability/fixtures.mjs';
import { assertNoHandlerClones } from '../scripts/check-professional-handler-clones.mjs';
import {
  contextFor,
  assertEffectContract as assertContract,
} from './support/professional-capability-delivery-support.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const capabilities = JSON.parse(readFileSync(join(root, 'catalog/capabilities.json'), 'utf8'));
const coverage = JSON.parse(readFileSync(join(root, 'catalog/prototype-coverage.json'), 'utf8'));
const effectContracts = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/professional-capability-effect-contracts.json'), 'utf8'),
);
const handlerIds = [...listProfessionalHandlers()].sort();

function assertEffectContract(id, outcome) {
  assertContract(assert, effectContracts, id, outcome);
}

const THEATER_METHODS = new Set([
  'local-professional-workspace',
  'local-standards-review',
  'local-automation-or-platform',
  'local-security-transform',
  'local-pdf-mutation-subset',
  'local-viewer-state',
  'local-a11y-evidence',
  'local-integration-config',
  'local-automation-job-accept',
  'local-page-op-pdf',
  'local-specialist-inventory',
  'local-preflight-review',
  'local-scanner-inventory',
  'local-pdf-portfolio',
  'local-color-convert-review',
]);

test('professional handlers cover every catalog capability that uses this evidence file', () => {
  const evidenceIds = capabilities
    .filter((c) => c.evidence?.reference === 'tests/professional-capability-delivery.test.js')
    .map((c) => c.id)
    .sort();
  assert.ok(evidenceIds.length >= 275, `expected >=275 evidence-backed promotions, got ${evidenceIds.length}`);
  for (const id of evidenceIds) {
    assert.equal(typeof getProfessionalHandler(id), 'function', `${id} has a production handler`);
  }
});

test('catalog professional delivery is fully implemented with zero planned records', () => {
  assert.equal(capabilities.length, 318);
  assert.equal(capabilities.filter((c) => c.delivery === 'planned').length, 0);
  assert.equal(capabilities.filter((c) => c.delivery === 'implemented').length, 318);
  for (const capability of capabilities) {
    assert.match(capability.evidence?.kind ?? '', /test/);
    assert.match(capability.evidence.reference, /\S/);
  }
  assert.ok(coverage.records.every((r) => r.delivery === 'implemented' && r.tier === 'exact-alpha'));
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
    if (typeof contract.method === 'string' && /proposal|stub|inventory|probe|descriptor/i.test(contract.method)) {
      assert.fail(`${id} method looks like theater: ${contract.method}`);
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

test('every professional handler delivers a real ok result for deterministic fixtures', async () => {
  resetAiPolicyForTests();
  let delivered = 0;
  for (const id of handlerIds) {
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
  assert.equal(delivered, handlerIds.length);
  assert.equal(handlerIds.length, 318, `expected 318 handlers, got ${handlerIds.length}`);
  const plannedEvidenceIds = capabilities
    .filter((c) => c.evidence?.reference === 'tests/professional-capability-delivery.test.js')
    .map((c) => c.id);
  for (const id of plannedEvidenceIds) {
    assert.ok(handlerIds.includes(id), `missing handler for ${id}`);
  }
});

test('skeptic-probed IDs enforce real domain effects (not status probes)', async () => {
  const sandbox = await deliverProfessionalCapability('platform.plugins.runtime-sandbox', contextFor('platform.plugins.runtime-sandbox'));
  assert.equal(sandbox.ok, true);
  assert.equal(sandbox.ready, true);
  assert.equal(sandbox.privateWorkspace, true);
  assert.ok(sandbox.isolation?.privateWorkspace);
  // Honesty: networkOsIsolated may be false when loopback is reachable (ECONNREFUSED).
  assert.equal(typeof sandbox.networkOsIsolated, 'boolean');
  assert.equal(sandbox.networkPolicyDeny, true);
  // Do not invent OS network isolation.
  if (sandbox.isolation?.networkProbe?.status === 'reachable') {
    assert.equal(sandbox.networkOsIsolated, false);
    assert.equal(sandbox.isolation.networkDenied, false);
  }
  assert.equal(sandbox.method, 'local-enforced-operation-sandbox');

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

  const a11y = await deliverProfessionalCapability('accessibility.check', contextFor('accessibility.check'));
  assert.equal(a11y.ok, true);
  assert.ok(a11y.report?.checks?.length >= 1);
  assert.match(a11y.method, /a11y/i);

  const review = await deliverProfessionalCapability('review.comments', contextFor('review.comments'));
  assert.equal(review.ok, true);
  assert.ok(Buffer.isBuffer(review.pdf));
  assert.equal(review.annotationSubtype, 'Text');

  const remediate = await deliverProfessionalCapability('accessibility.remediate-tags', contextFor('accessibility.remediate-tags'));
  assert.equal(remediate.ok, true);
  assert.equal(remediate.applied, true);
  assert.equal(remediate.structureLinked, true);
  assert.ok(Buffer.isBuffer(remediate.pdf));
  assert.ok(remediate.pdf.toString('latin1').includes('/StructTreeRoot'));
  assert.equal(remediate.method, 'local-tagged-pdf-remediation-writer');
});

test('sign.certificate produces a signature container PDF with CMS proof', async () => {
  const outcome = await deliverProfessionalCapability('sign.certificate', contextFor('sign.certificate'));
  assert.equal(outcome.ok, true);
  assert.ok(Buffer.isBuffer(outcome.pdf));
  assert.match(outcome.outputSha256, /^[0-9a-f]{64}$/);
  assert.match(outcome.cmsSha256, /^[0-9a-f]{64}$/);
  assert.ok(outcome.pdf.includes(Buffer.from('/ByteRange', 'latin1')) || outcome.proof);
  assert.equal(outcome.method, 'local-pdf-signature-container');
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

test('forms.fill-save writes the filled value into the AcroForm widget /V of the derived PDF', async () => {
  const { parsePdfStructure, resolvePdfObject } = await import('../scripts/host/pdf-classic-structure.mjs');
  const { pdfDictionary } = await import('../scripts/host/pdf-classic-syntax.mjs');
  const { pdfUtf16BeString } = await import('../scripts/host/pdf-classic-text-string.mjs');
  const outcome = await deliverProfessionalCapability('forms.fill-save', {
    sourcePdf: formFixture(),
    value: 'Ada Lovelace',
    fieldName: 'Account.Name',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.method, 'local-acroform-prepare-and-set-V');
  assert.ok(Buffer.isBuffer(outcome.pdf));
  assert.ok(outcome.widgetReference);
  const structure = parsePdfStructure(outcome.pdf);
  const widget = pdfDictionary(resolvePdfObject(structure, outcome.widgetReference).value);
  assert.equal(widget.get('FT')?.value, 'Tx');
  assert.ok(widget.get('V')?.bytes?.equals(pdfUtf16BeString('Ada Lovelace').bytes));
  assert.notEqual(outcome.emptyFormSha256, outcome.outputSha256);
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
  const outcome = await deliverProfessionalCapability('compare.content', {
    leftText: 'alpha beta gamma',
    rightText: 'alpha delta gamma',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.changed, true);
  assert.equal(outcome.stats.added, 1);
  assert.equal(outcome.stats.deleted, 1);
  assert.equal(outcome.method, 'local-comparison-algorithms-diffTokens');
});

test('create.blank-pdf and convert paths reject invalid professional inputs', async () => {
  await assert.rejects(
    () => deliverProfessionalCapability('create.blank-pdf', { pages: 0 }),
    (error) => error?.code === 'INVALID_PAGE_COUNT' || error?.code === 'INVALID_CAPABILITY_INPUT' || /page/i.test(error?.message ?? ''),
  );
  await assert.rejects(
    () => deliverProfessionalCapability('create.cad-to-pdf', { sourceBytes: Buffer.from('not-cad') }),
    (error) => error?.code === 'UNSUPPORTED_CAD_INPUT' || error?.code === 'INVALID_CAD_INPUT',
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

test('export.excel produces a real OOXML spreadsheet package', async () => {
  const outcome = await deliverProfessionalCapability('export.excel', {
    text: 'Name,Value\nA,1\n',
    pages: [{ text: 'Name Value\nA 1' }],
  });
  assert.equal(outcome.ok, true);
  assert.ok(Buffer.isBuffer(outcome.bytes));
  assert.equal(outcome.bytes.subarray(0, 2).toString('ascii'), 'PK');
  assert.match(outcome.sha256, /^[0-9a-f]{64}$/);
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

