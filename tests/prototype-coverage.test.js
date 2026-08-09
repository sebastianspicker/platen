import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
const capabilities = readJson('catalog/capabilities.json');
const coverage = readJson('catalog/prototype-coverage.json');
const proofs = readJson('catalog/capability-proofs/proofs.json');
const tiers = new Set(['exact-alpha', 'executable-subset', 'sidecar', 'proposal', 'descriptor', 'service-only', 'blocked', 'excluded']);
const documentedNarrowTiers = new Map([
  ['scan.duplex-feeder', 'service-only'],
  ['accessibility.document-language-title', 'sidecar'],
  ['accessibility.form-semantics', 'sidecar'],
  ['accessibility.links-bookmarks', 'sidecar'],
  ['accessibility.table-semantics', 'sidecar'],
  ['aec.collaborative-review-sessions', 'sidecar'],
  ['aec.measurement-toolset', 'sidecar'],
  ['aec.sets-drawing-log', 'sidecar'],
  ['redaction.mark', 'sidecar'],
  ['redaction.preview', 'sidecar'],
  ['redaction.report', 'sidecar'],
  ['platform.plugins.package-verification', 'service-only'],
]);

test('prototype coverage closes exactly over the professional capability catalog', () => {
  assert.equal(coverage.schemaVersion, 1);
  assert.equal(coverage.records.length, capabilities.length);
  assert.equal(coverage.records.length, 318);
  assert.deepEqual(coverage.records.map(({ id }) => id), capabilities.map(({ id }) => id));
  assert.deepEqual(coverage.records.map(({ delivery }) => delivery), capabilities.map(({ delivery }) => delivery));
  assert.equal(new Set(coverage.records.map(({ id }) => id)).size, coverage.records.length);
  for (const record of coverage.records) {
    assert.deepEqual(Object.keys(record).sort(), ['delivery', 'id', 'tier']);
    assert.ok(tiers.has(record.tier), `${record.id} uses a declared prototype tier`);
  }
});

test('prototype delivery and tier follow proof status without mass promotion', () => {
  const proofById = new Map(proofs.records.map((record) => [record.capabilityId, record]));
  const provenCount = proofs.records.filter(({ status }) => status === 'proven').length;
  const partialCount = proofs.records.filter(({ status }) => status === 'partial').length;
  const falseCount = proofs.records.filter(({ status }) => status === 'false').length;
  assert.equal(coverage.records.filter(({ delivery }) => delivery === 'implemented').length, provenCount);
  assert.equal(coverage.records.filter(({ tier }) => tier === 'exact-alpha').length, provenCount);
  assert.equal(coverage.records.filter(({ delivery }) => delivery === 'planned').length, partialCount + falseCount);
  for (const record of coverage.records) {
    const proof = proofById.get(record.id);
    assert.ok(proof, `${record.id} has a proof record`);
    if (proof.status === 'proven') {
      assert.equal(record.delivery, 'implemented');
      assert.equal(record.tier, 'exact-alpha');
    } else {
      assert.equal(record.delivery, 'planned');
      const documentedTier = documentedNarrowTiers.get(record.id);
      const expectedTier = documentedTier
        ?? (proof.status === 'partial' ? 'executable-subset' : record.id.startsWith('ai.') ? 'excluded' : 'blocked');
      assert.equal(record.tier, expectedTier, `${record.id} uses the truthful planned tier`);
    }
  }
  assert.equal(coverage.records.filter(({ tier }) => tier === 'exact-alpha').length, provenCount);
  const tierCounts = Object.fromEntries([...tiers].map((tier) => [
    tier,
    coverage.records.filter((record) => record.tier === tier).length,
  ]));
  assert.deepEqual(tierCounts, {
    'exact-alpha': 210,
    'executable-subset': 18,
    sidecar: 0,
    proposal: 0,
    'service-only': 1,
    descriptor: 0,
    blocked: 74,
    excluded: 15,
  });
  assert.equal(documentedNarrowTiers.has('aec.batch-slip-sheet'), false);
});

test('specific truth boundaries remain explicit', () => {
  assert.deepEqual(coverage.records.find((record) => record.id === 'platform.plugins.runtime-sandbox'), {
    id: 'platform.plugins.runtime-sandbox', delivery: 'planned', tier: 'blocked',
  });
  assert.deepEqual(coverage.records.find((record) => record.id === 'forms.source-bound-acroform-fill-save'), {
    id: 'forms.source-bound-acroform-fill-save', delivery: 'implemented', tier: 'exact-alpha',
  });
  assert.deepEqual(coverage.records.find((record) => record.id === 'ai.ask-document'), {
    id: 'ai.ask-document', delivery: 'planned', tier: 'excluded',
  });
  assert.deepEqual(coverage.records.find((record) => record.id === 'standards.pdf-a'), {
    id: 'standards.pdf-a', delivery: 'planned', tier: 'blocked',
  });
});
