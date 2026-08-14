import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_PROOF_PATH,
  CAPABILITY_PROOF_SCHEMA_PATH,
  validateCapabilityProofManifest,
  verifyCapabilityProofs,
} from '../scripts/verify-capability-proofs.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (repositoryPath) => JSON.parse(readFileSync(join(root, repositoryPath), 'utf8'));
const catalog = readJson('catalog/capabilities.json');
const manifest = readJson(CAPABILITY_PROOF_PATH);
const cloneManifest = () => structuredClone(manifest);

test('capability proof gate closes over all catalog IDs with a reconciled audit status', () => {
  assert.deepEqual(verifyCapabilityProofs(root), {
    total: 318,
    audited: 318,
    proven: 210,
    partial: 19,
    false: 89,
    unaudited: 0,
  });
  assert.deepEqual(
    manifest.records.map(({ capabilityId }) => capabilityId),
    catalog.map(({ id }) => id).sort(),
  );
  assert.equal(manifest.records.every(({ audited }) => audited), true);
});

test('P0 truth overrides prevent policy, unsupported cryptography, conformance, and lifecycle promotion', () => {
  const statusById = new Map(manifest.records.map(({ capabilityId, status }) => [capabilityId, status]));
  for (const prefix of ['ai.', 'standards.']) {
    assert.equal(
      manifest.records.filter(({ capabilityId }) => capabilityId.startsWith(prefix)).every(({ status }) => status === 'false'),
      true,
      `${prefix} claims remain false`,
    );
  }
  assert.deepEqual(
    ['sign.electronic', 'sign.certificate', 'sign.validate-certificate'].map((id) => statusById.get(id)),
    ['proven', 'proven', 'proven'],
  );
  assert.equal(
    manifest.records
      .filter(({ capabilityId }) => capabilityId.startsWith('sign.'))
      .filter(({ capabilityId }) => !['sign.electronic', 'sign.certificate', 'sign.validate-certificate'].includes(capabilityId))
      .every(({ status }) => status === 'false'),
    true,
    'unsupported signing claims remain false',
  );
  assert.equal(statusById.get('platform.plugins.lifecycle'), 'proven');
  assert.equal(statusById.get('platform.plugins.runtime-sandbox'), 'false');
  assert.notEqual(statusById.get('scan.acquire'), 'proven');
  assert.equal(statusById.get('export.selected-region'), 'proven');
  assert.equal(statusById.get('document.article-threads'), 'false');
  assert.deepEqual(
    manifest.records
      .filter(({ capabilityId, status }) => (
        capabilityId.startsWith('integrations.') || capabilityId.startsWith('admin.')
      ) && status === 'proven')
      .map(({ capabilityId }) => capabilityId),
    ['admin.audit-telemetry', 'admin.plugin-allowlist', 'admin.policy-configuration'],
  );
});

test('capability proof schema exposes every required proof dimension', () => {
  const schema = readJson(CAPABILITY_PROOF_SCHEMA_PATH);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.$defs.proofRecord.required, [
    'capabilityId', 'audited', 'status', 'shippedSurface', 'sourceBinding',
    'failureEvidence', 'trustBoundary', 'independentValidation', 'evidenceRefs', 'rationale',
  ]);
});

test('capability proof gate rejects duplicate IDs and unsupported unaudited promotion', () => {
  const duplicate = cloneManifest();
  duplicate.records[0].capabilityId = duplicate.records[1].capabilityId;
  assert.throws(
    () => validateCapabilityProofManifest({ root, catalog, manifest: duplicate }),
    /duplicate capability IDs/,
  );

  const promoted = cloneManifest();
  promoted.records[0].audited = false;
  promoted.records[0].status = 'proven';
  assert.throws(
    () => validateCapabilityProofManifest({ root, catalog, manifest: promoted }),
    /is unaudited and must use status unaudited/,
  );
});

test('capability proof gate rejects weak proven records and unresolvable evidence', () => {
  const weakProof = cloneManifest();
  const proven = weakProof.records.find((record) => record.status === 'proven');
  proven.sourceBinding.assessment = 'partial';
  assert.throws(
    () => validateCapabilityProofManifest({ root, catalog, manifest: weakProof }),
    /cannot be proven without verified source binding/,
  );

  const missingEvidence = cloneManifest();
  const audited = missingEvidence.records.find((record) => record.audited);
  audited.evidenceRefs.push('tests/does-not-exist-capability-proof.test.js');
  assert.throws(
    () => validateCapabilityProofManifest({ root, catalog, manifest: missingEvidence }),
    /does not name an existing file/,
  );
});

test('partial and false statuses must name the deficient proof dimension', () => {
  const vaguePartial = cloneManifest();
  const partial = vaguePartial.records.find((record) => record.status === 'partial');
  for (const dimension of ['sourceBinding', 'failureEvidence', 'trustBoundary', 'independentValidation']) {
    partial[dimension].assessment = 'verified';
  }
  assert.throws(
    () => validateCapabilityProofManifest({ root, catalog, manifest: vaguePartial }),
    /is partial but records no partial or absent proof dimension/,
  );

  const vagueFalse = cloneManifest();
  const falseRecord = vagueFalse.records.find((record) => record.status === 'false');
  for (const dimension of ['sourceBinding', 'failureEvidence', 'trustBoundary', 'independentValidation']) {
    falseRecord[dimension].assessment = 'partial';
  }
  assert.throws(
    () => validateCapabilityProofManifest({ root, catalog, manifest: vagueFalse }),
    /is false but records no absent proof dimension/,
  );
});
