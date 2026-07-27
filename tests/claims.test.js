import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
const capabilities = readJson('catalog/capabilities.json');

test('planned claims carry no implementation evidence', () => {
  for (const capability of capabilities.filter(({ delivery }) => delivery === 'planned')) {
    assert.equal(capability.evidence, null, `${capability.id} remains an unimplemented claim`);
  }
});

test('sensitive advanced functions are professionally implemented with test evidence', () => {
  const sensitiveIds = [
    'sign.electronic', 'sign.certificate', 'sign.routed-workflow',
    'security.permission-controls', 'security.certificate-encryption',
    'redaction.apply', 'sanitize.hidden-data', 'ocr.editable-output',
    'accessibility.remediate-tags', 'standards.pdf-a', 'standards.pdf-x', 'standards.pdf-ua', 'preflight.fixups',
    'automation.api', 'ai.ask-document', 'aec.measurement',
    'platform.plugins.install', 'platform.plugins.rpc'
  ];
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  for (const id of sensitiveIds) {
    assert.equal(byId.get(id)?.delivery, 'implemented', `${id} must be professionally implemented`);
    assert.equal(byId.get(id)?.evidence?.kind, 'test');
    assert.match(byId.get(id)?.evidence?.reference ?? '', /\S/);
  }
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
