import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcroFormFillValidationEndpoints } from '../src/core/local-host-acroform-fill-validation-endpoints.js';
import { LocalHostClient } from '../src/core/local-host-client.js';

const documentId = '123e4567-e89b-12d3-a456-426614174000';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const fillRequest = { profile: 'local-acroform-fill-save-v1', sourceSha256, fieldName: 'Account.Name', value: 'Ada' };
const validationRequest = {
  profile: 'local-acroform-validation-v1', sourceSha256,
  values: { 'Account.Name': 'Ada', Approved: true },
  rules: { 'Account.Name': { required: true, minLength: 3 }, Approved: { type: 'boolean' } },
};

function fillResult() {
  const proof = {
    profile: fillRequest.profile, sourceSha256, fieldNameSha256: 'c'.repeat(64), valueSha256: 'd'.repeat(64),
    fieldType: 'text', widgetReference: { object: 7, generation: 0 }, sourcePrefixPreserved: true,
    semanticValueValidated: true, revisionCount: 2,
  };
  const operation = {
    schemaVersion: 1, id: '123e4567-e89b-42d3-a456-426614174001', type: 'pdf-acroform-fill-save',
    inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
    parameters: { profile: fillRequest.profile, fieldNameSha256: proof.fieldNameSha256, valueSha256: proof.valueSha256, fieldType: proof.fieldType, widgetReference: proof.widgetReference },
    expected: { outputSha256, sourcePrefixPreserved: true, signaturePreservation: false },
    validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'bounded-acroform-fill-save-core', 'independent-fill-save-reinspection', 'output-sha256'], outputSha256 },
    completedAt: '2026-08-04T00:00:00.000Z',
  };
  return {
    kind: 'pdf-acroform-fill-save',
    artifact: { id: '123e4567-e89b-42d3-a456-426614174002', documentId, displayName: 'filled-form.pdf', mediaType: 'application/pdf', size: 100, sha256: outputSha256, operation, createdAt: '2026-08-04T00:00:00.000Z' },
    proof,
    limitations: ['Exactly one existing terminal text, choice, canonical checkbox, or canonical radio field is updated in a separate incremental derived PDF.', 'No appearance regeneration, flattening, calculations, interchange, XFA, signature preservation, or byte-preservation claim is made.'],
  };
}

function validationResult() {
  return {
    kind: 'pdf-acroform-validation', sourceDigest: sourceSha256, fieldCount: 2, valid: false,
    errors: [{ fieldNameSha256: 'e'.repeat(64), code: 'MIN_LENGTH' }],
    limitations: ['Read-only validation for up to 100 existing terminal classic AcroForm fields.', 'No regex rules, mutation, artifact creation, calculations, XFA, actions, JavaScript, signatures, or unsupported PDF graphs are supported.'],
    localOnly: true,
  };
}

test('AcroForm fill/save and validation endpoints send canonical bounded POST requests', async () => {
  const calls = [];
  const endpoints = createAcroFormFillValidationEndpoints({ json: async (path, options) => {
    calls.push({ path, options });
    return { result: path.endsWith('/acroform-fill-save') ? fillResult() : validationResult() };
  } });
  const fill = await endpoints.fillAndSaveAcroForm(documentId, fillRequest);
  const validation = await endpoints.validateAcroFormValues(documentId, validationRequest);
  assert.equal(calls[0].path, `/api/documents/${documentId}/acroform-fill-save`);
  assert.equal(calls[1].path, `/api/documents/${documentId}/acroform-validate`);
  assert.deepEqual(JSON.parse(calls[0].options.body), fillRequest);
  assert.deepEqual(JSON.parse(calls[1].options.body), validationRequest);
  assert.equal(Object.isFrozen(fill), true);
  assert.equal(Object.isFrozen(fill.artifact.operation.validation.validators), true);
  assert.equal(Object.isFrozen(validation.errors), true);
});

test('AcroForm fill/save and validation clients reject proxies, accessors, symbols, extras, and regex rules', () => {
  const endpoint = createAcroFormFillValidationEndpoints({ json: async () => ({ result: fillResult() }) });
  assert.throws(() => endpoint.fillAndSaveAcroForm(documentId, { ...fillRequest, extra: true }), TypeError);
  assert.throws(() => endpoint.fillAndSaveAcroForm(documentId, new Proxy(fillRequest, {})), TypeError);
  const accessor = { ...fillRequest }; Object.defineProperty(accessor, 'value', { get: () => 'Ada', enumerable: true });
  assert.throws(() => endpoint.fillAndSaveAcroForm(documentId, accessor), TypeError);
  const symbolRequest = { ...fillRequest, [Symbol('extra')]: true };
  assert.throws(() => endpoint.fillAndSaveAcroForm(documentId, symbolRequest), TypeError);
  assert.throws(() => endpoint.validateAcroFormValues(documentId, { ...validationRequest, rules: { 'Account.Name': { pattern: '.*' } } }), TypeError);
  assert.throws(() => endpoint.validateAcroFormValues(documentId, { ...validationRequest, values: { ...validationRequest.values, Too: 1 } }), TypeError);
});

test('LocalHostClient exposes strict R04 AcroForm fill/save and validation methods', async () => {
  const token = 'f'.repeat(64); const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    return new Response(JSON.stringify({ result: path.endsWith('/acroform-fill-save') ? fillResult() : validationResult() }), { status: 200 });
  } });
  await client.bootstrap();
  await client.fillAndSaveAcroForm(documentId, fillRequest);
  await client.validateAcroFormValues(documentId, validationRequest);
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.equal(calls[2].options.headers['X-Platen-Token'], token);
});
