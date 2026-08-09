import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
const capabilities = readJson('catalog/capabilities.json');
const proofs = readJson('catalog/capability-proofs/proofs.json');
const proofById = new Map(proofs.records.map((record) => [record.capabilityId, record]));

test('catalog delivery is exactly the proof status projection', () => {
  assert.equal(capabilities.length, 318);
  assert.equal(proofs.records.length, capabilities.length);
  for (const capability of capabilities) {
    const proof = proofById.get(capability.id);
    assert.ok(proof, `${capability.id} has an authoritative proof record`);
    assert.equal(capability.delivery, proof.status === 'proven' ? 'implemented' : 'planned');
    if (proof.status === 'proven') {
      assert.equal(typeof capability.evidence, 'object', `${capability.id} proven claims retain evidence`);
    } else {
      assert.equal(capability.evidence, null, `${capability.id} remains an unimplemented claim`);
    }
  }
});

test('proven claims retain test-backed evidence and non-proven claims do not', () => {
  for (const proof of proofs.records) {
    const capability = capabilities.find(({ id }) => id === proof.capabilityId);
    if (proof.status !== 'proven') continue;
    assert.equal(capability.delivery, 'implemented');
    assert.match(capability.evidence?.kind ?? '', /\S/);
    assert.match(capability.evidence?.reference ?? '', /\S/);
  }
});

test('policy and unavailable boundaries are not promoted by a narrower prototype subset', () => {
  const statusById = new Map(proofs.records.map(({ capabilityId, status }) => [capabilityId, status]));
  for (const prefix of ['ai.', 'standards.']) {
    assert.equal([...statusById.entries()].filter(([id]) => id.startsWith(prefix)).every(([, status]) => status === 'false'), true, `${prefix} claims remain false`);
  }
  assert.deepEqual(
    ['sign.electronic', 'sign.certificate', 'sign.validate-certificate'].map((id) => statusById.get(id)),
    ['proven', 'proven', 'proven'],
  );
  assert.equal(
    [...statusById.entries()]
      .filter(([id]) => id.startsWith('sign.') && !['sign.electronic', 'sign.certificate', 'sign.validate-certificate'].includes(id))
      .every(([, status]) => status === 'false'),
    true,
    'unsupported signing claims remain false',
  );
  assert.equal(statusById.get('platform.plugins.runtime-sandbox'), 'false');
  assert.equal(statusById.get('export.selected-region'), 'proven');
  assert.equal(statusById.get('document.article-threads'), 'false');
});

test('retired umbrella IDs cannot conceal partially implemented functions', () => {
  const retired = [
    'pages.split-extract', 'pages.reorder-delete', 'pages.crop-rotate',
    'forms.validate-calculate', 'security.passwords-permissions',
    'compare.text-graphics', 'standards.pdf-x-pdf-ua',
    'print.separations-output-preview', 'aec.studio-sessions',
  ];
  const ids = new Set(capabilities.map(({ id }) => id));
  for (const id of retired) assert.equal(ids.has(id), false, `${id} remains retired`);
});

test('contract schemas are strict and represent the declared states', () => {
  for (const name of ['family', 'capability', 'pack', 'plugin-manifest', 'plugin-package', 'plugin-rpc', 'plugin-worker-control', 'prototype-coverage', 'research-provenance', 'research-scope', 'runtime-plugin-manifest', 'accessibility-review', 'accessibility-remediation-proposal', 'source-bound-redaction-plan', 'standards-validation', 'ocr-document', 'ocr-layout', 'ocr-batch', 'aec-calibration', 'aec-measurement', 'aec-materialization', 'portable-project-manifest', 'prepress-artifact', 'prepress-production-validation']) {
    const schema = readJson(`contracts/${name}.schema.json`);
    assert.equal(schema.additionalProperties, false, `${name} forbids undeclared fields`);
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0, `${name} has required fields`);
  }
  const capabilitySchema = readJson('contracts/capability.schema.json');
  assert.deepEqual(capabilitySchema.properties.delivery.enum, ['implemented', 'planned']);
  const manifestSchema = readJson('contracts/plugin-manifest.schema.json');
  assert.equal(manifestSchema.properties.status.const, 'planned');
  assert.ok(!Object.hasOwn(manifestSchema.properties, 'entrypoint'));
});
