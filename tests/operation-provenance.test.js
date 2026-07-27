import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPERATION_PROVENANCE_VERSION,
  createOperationProvenance,
  validateOperationProvenance,
} from '../scripts/host/operation-provenance.mjs';

const documentId = '123e4567-e89b-42d3-a456-426614174000';
const sha256 = 'a'.repeat(64);

function valid(overrides = {}) {
  return {
    type: 'arrange-pages',
    inputs: [{ documentId, sha256, role: 'primary' }],
    parameters: { pages: [2, 1] },
    expected: { pageCount: 2 },
    validation: { passed: true, validators: ['pdfinfo-page-count', 'source-sha256'] },
    ...overrides,
  };
}

test('operation provenance is versioned, normalized, and deeply immutable', () => {
  const record = createOperationProvenance(valid());
  assert.equal(record.schemaVersion, OPERATION_PROVENANCE_VERSION);
  assert.match(record.id, /^[0-9a-f-]{36}$/i);
  assert.equal(record.inputs[0].sha256, sha256);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.inputs), true);
  assert.equal(Object.isFrozen(record.parameters.pages), true);
  assert.deepEqual(validateOperationProvenance(record), record);
});

test('operation provenance permits source-free document creation', () => {
  const record = createOperationProvenance(valid({
    type: 'create-blank-pdf', inputs: [], parameters: { pages: 1 }, expected: { pageCount: 1 },
  }));
  assert.deepEqual(record.inputs, []);
});

test('operation provenance rejects failed or evidence-free validation', () => {
  assert.throws(
    () => createOperationProvenance(valid({ validation: { passed: false, validators: ['pdfinfo'] } })),
    { code: 'INVALID_OPERATION_PROVENANCE', status: 500 },
  );
  assert.throws(
    () => createOperationProvenance(valid({ validation: { passed: true, validators: [] } })),
    { code: 'INVALID_OPERATION_PROVENANCE', status: 500 },
  );
});

test('operation provenance rejects unsafe JSON and untrusted identifiers', () => {
  assert.throws(
    () => createOperationProvenance(valid({ inputs: [{ documentId: '../source.pdf', sha256, role: 'primary' }] })),
    { code: 'INVALID_OPERATION_PROVENANCE', status: 500 },
  );
  const asset = createOperationProvenance(valid({
    inputs: [{ assetId: documentId, sha256, role: 'source' }],
  }));
  assert.equal(asset.inputs[0].assetId, documentId);
  assert.equal(Object.hasOwn(asset.inputs[0], 'documentId'), false);
  assert.throws(
    () => createOperationProvenance(valid({ parameters: { value: Number.NaN } })),
    { code: 'INVALID_OPERATION_PROVENANCE', status: 500 },
  );
  const polluted = Object.create(null);
  Object.defineProperty(polluted, '__proto__', { enumerable: true, value: { polluted: true } });
  assert.throws(
    () => createOperationProvenance(valid({ parameters: polluted })),
    { code: 'INVALID_OPERATION_PROVENANCE', status: 500 },
  );
});

test('operation provenance rejects unknown schema fields and noncanonical timestamps', () => {
  const record = createOperationProvenance(valid());
  assert.throws(
    () => validateOperationProvenance({ ...record, extra: true }),
    { code: 'INVALID_OPERATION_PROVENANCE', status: 500 },
  );
  assert.throws(
    () => createOperationProvenance(valid({ completedAt: '2026-01-01' })),
    { code: 'INVALID_OPERATION_PROVENANCE', status: 500 },
  );
});
