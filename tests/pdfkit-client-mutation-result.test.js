import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePdfKitMutationResult } from '../src/core/pdfkit-client-contract.js';
import { pdfKitClientMutationResult } from './support/pdfkit-client-result-fixture.js';

const context = Object.freeze({
  documentId: '11111111-1111-4111-8111-111111111111',
  sourceSha256: 'b'.repeat(64),
  profile: 'macos-pdfkit-derived-v1',
  mutation: Object.freeze({
    metadata: null,
    rotation: null,
    annotations: Object.freeze([]),
    pageBox: Object.freeze({
      page: 2,
      box: 'bleed',
      rect: Object.freeze({ x: 12, y: 18, width: 560, height: 740 }),
    }),
  }),
});

function validResult() {
  return pdfKitClientMutationResult(context);
}

function rejected(result) {
  assert.throws(() => validatePdfKitMutationResult(result, context), {
    code: 'INVALID_LOCAL_HOST',
  });
}

test('PDFKit client accepts an exactly source/request/output-bound BleedBox result', () => {
  const result = validResult();
  assert.equal(validatePdfKitMutationResult(result, context), result);
  assert.deepEqual(result.artifact.operation.validation.persistentBleedBox, {
    x: 12, y: 18, width: 560, height: 740,
  });
  assert.equal(result.evidence.allPageValidationRendersMatched, true);
});

test('PDFKit client rejects crossed identity, digest, rectangle, validator, and evidence bindings', () => {
  const mutations = [
    (value) => { value.artifact.documentId = '44444444-4444-4444-8444-444444444444'; },
    (value) => { value.sourceDigest = '0'.repeat(64); },
    (value) => { value.artifact.operation.inputs[0].documentId = '44444444-4444-4444-8444-444444444444'; },
    (value) => { value.artifact.operation.inputs[0].sha256 = '0'.repeat(64); },
    (value) => { value.artifact.operation.validation.persistentBleedBox.width = 559; },
    (value) => { value.artifact.operation.validation.validators.pop(); },
    (value) => { value.evidence.allPageValidationRendersMatched = false; },
    (value) => { value.artifact.operation.validation.outputSha256 = '0'.repeat(64); },
    (value) => { value.artifact.operation.parameters.pageBox.page = 1; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(validResult());
    mutate(candidate);
    rejected(candidate);
  }
});

test('PDFKit client rejects partial, overbroad, or legacy universal-render receipts', () => {
  rejected({ kind: 'pdfkit-structure-mutation', artifact: { id: 'derived' } });
  const extra = structuredClone(validResult());
  extra.untrusted = true;
  rejected(extra);
  const legacy = structuredClone(validResult());
  delete legacy.evidence.allPageValidationRendersMatched;
  legacy.evidence.allPageRendersMatched = true;
  rejected(legacy);
});
