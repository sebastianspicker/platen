import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
const capabilities = readJson('catalog/capabilities.json');
const coverage = readJson('catalog/prototype-coverage.json');
const tiers = new Set(['exact-alpha', 'executable-subset', 'sidecar', 'proposal', 'descriptor', 'service-only', 'blocked', 'excluded']);

test('prototype coverage closes exactly over the professional capability catalog', () => {
  assert.equal(coverage.schemaVersion, 1);
  assert.equal(coverage.records.length, 318);
  assert.deepEqual(coverage.records.map(({ id }) => id), capabilities.map(({ id }) => id));
  assert.deepEqual(coverage.records.map(({ delivery }) => delivery), capabilities.map(({ delivery }) => delivery));
  assert.equal(new Set(coverage.records.map(({ id }) => id)).size, coverage.records.length);
  for (const record of coverage.records) {
    assert.deepEqual(Object.keys(record).sort(), ['delivery', 'id', 'tier']);
    assert.ok(tiers.has(record.tier), `${record.id} uses a declared prototype tier`);
  }
});

test('full professional promotion records every capability as implemented exact-alpha', () => {
  assert.equal(capabilities.filter(({ delivery }) => delivery === 'implemented').length, 318);
  assert.equal(capabilities.filter(({ delivery }) => delivery === 'planned').length, 0);
  assert.ok(coverage.records.every((record) => record.delivery === 'implemented'));
  assert.ok(coverage.records.every((record) => record.tier === 'exact-alpha'));
  assert.equal(coverage.records.filter(({ tier }) => tier === 'exact-alpha').length, 318);
  assert.equal(coverage.records.filter(({ tier }) => tier === 'blocked').length, 0);
  assert.equal(coverage.records.filter(({ tier }) => tier === 'excluded').length, 0);
  assert.equal(coverage.records.filter(({ tier }) => tier === 'sidecar').length, 0);
  assert.deepEqual(coverage.records.find((record) => record.id === 'forms.source-bound-acroform-fill-save'), {
    id: 'forms.source-bound-acroform-fill-save', delivery: 'implemented', tier: 'exact-alpha',
  });
  assert.deepEqual(coverage.records.find((record) => record.id === 'ai.ask-document'), {
    id: 'ai.ask-document', delivery: 'implemented', tier: 'exact-alpha',
  });
  assert.deepEqual(coverage.records.find((record) => record.id === 'standards.pdf-a'), {
    id: 'standards.pdf-a', delivery: 'implemented', tier: 'exact-alpha',
  });
});
