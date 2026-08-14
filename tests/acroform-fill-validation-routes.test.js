import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleAcroFormFillValidationRoute } from '../scripts/host/routes/acroform-fill-validation-routes.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const sourceSha256 = 'a'.repeat(64);
const artifactSha256 = 'b'.repeat(64);
const operationId = '22222222-2222-4222-8222-222222222222';
const artifactId = '33333333-3333-4333-8333-333333333333';
const completedAt = '2026-08-04T00:00:00.000Z';

function response() { return Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false }); }
function context(operation, body, service) {
  const target = response();
  const processing = { signal: new AbortController().signal };
  const output = { target, processing, response: null };
  return {
    operation, request: { method: 'POST' }, response: target, url: new URL(`http://127.0.0.1/api/documents/${documentId}/${operation}`), documentId,
    processing, store: { getDocument: () => ({ sha256: sourceSha256 }), deleteArtifact: async () => {}, getArtifact: async () => null },
    acroFormFillSave: operation === 'acroform-fill-save' ? service : null,
    acroFormValidation: operation === 'acroform-validate' ? service : null,
    bodyLimit: 32_768, method: () => {}, readJson: async () => body,
    exactJsonObject: (value, keys) => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)),
    json: (_response, status, value) => { output.response = { status, value }; }, output,
  };
}

function fillResult() {
  const proof = {
    profile: 'local-acroform-fill-save-v1', sourceSha256, fieldNameSha256: 'c'.repeat(64), valueSha256: 'd'.repeat(64), fieldType: 'text',
    widgetReference: { object: 7, generation: 0 }, sourcePrefixPreserved: true, semanticValueValidated: true, revisionCount: 2,
  };
  const operation = {
    schemaVersion: 1, id: operationId, type: 'pdf-acroform-fill-save', inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
    parameters: { profile: proof.profile, fieldNameSha256: proof.fieldNameSha256, valueSha256: proof.valueSha256, fieldType: proof.fieldType, widgetReference: proof.widgetReference },
    expected: { outputSha256: artifactSha256, sourcePrefixPreserved: true, signaturePreservation: false },
    validation: { passed: true, validators: ['source-sha256', 'private-source-copy', 'bounded-acroform-fill-save-core', 'independent-fill-save-reinspection', 'output-sha256'], outputSha256: artifactSha256 }, completedAt,
  };
  return { kind: 'pdf-acroform-fill-save', artifact: { id: artifactId, documentId, displayName: 'filled-form.pdf', mediaType: 'application/pdf', size: 128, sha256: artifactSha256, operation, createdAt: completedAt }, proof, limitations: ['bounded'] };
}

test('AcroForm fill/save route passes exact body and returns a privacy-minimal 201 result', async () => {
  const body = { profile: 'local-acroform-fill-save-v1', sourceSha256, fieldName: 'Account.Name', value: 'Ada' };
  let received;
  const service = { fill: async (_documentId, request, options) => { received = { request, options }; return fillResult(); } };
  const value = context('acroform-fill-save', body, service);
  assert.equal(await handleAcroFormFillValidationRoute(value), true);
  assert.equal(value.output.response.status, 201);
  assert.equal(received.request, body);
  assert.equal(received.options.signal, value.processing.signal);
  assert.equal('filePath' in value.output.response.value.result.artifact, false);
});

test('AcroForm validation route rejects proxies and forged value-bearing errors', async () => {
  const body = { profile: 'local-acroform-validation-v1', sourceSha256, values: { 'Account.Name': '' }, rules: { 'Account.Name': { required: true } } };
  const service = { validate: async () => ({ kind: 'pdf-acroform-validation', sourceDigest: sourceSha256, fieldCount: 1, valid: false, errors: [{ fieldNameSha256: 'e'.repeat(64), code: 'REQUIRED', raw: 'Account.Name' }], limitations: ['bounded'], localOnly: true }) };
  const value = context('acroform-validate', body, service);
  await assert.rejects(handleAcroFormFillValidationRoute(value), { code: 'ACROFORM_VALIDATION_RESULT_INVALID', status: 502 });

  const proxyBody = new Proxy(body, {});
  const proxyContext = context('acroform-validate', proxyBody, service);
  await assert.rejects(handleAcroFormFillValidationRoute(proxyContext), { code: 'INVALID_ACROFORM_VALIDATION_OPTIONS', status: 400 });
});

test('AcroForm routes reject unavailable services, queries, extra keys, accessors, and malformed rules', async () => {
  const fillBody = { profile: 'local-acroform-fill-save-v1', sourceSha256, fieldName: 'Account.Name', value: 'Ada' };
  const unavailable = context('acroform-fill-save', fillBody, null);
  await assert.rejects(handleAcroFormFillValidationRoute(unavailable), { code: 'ACROFORM_FILL_SAVE_UNAVAILABLE', status: 503 });
  const query = context('acroform-fill-save', fillBody, { fill: async () => fillResult() });
  query.url = new URL(`${query.url}?q=1`);
  await assert.rejects(handleAcroFormFillValidationRoute(query), { code: 'INVALID_PARAMETER', status: 400 });
  const extra = context('acroform-fill-save', { ...fillBody, extra: true }, { fill: async () => fillResult() });
  await assert.rejects(handleAcroFormFillValidationRoute(extra), { code: 'INVALID_ACROFORM_FILL_SAVE_OPTIONS', status: 400 });
  const accessorBody = { ...fillBody };
  Object.defineProperty(accessorBody, 'value', { enumerable: true, get: () => 'Ada' });
  const accessor = context('acroform-fill-save', accessorBody, { fill: async () => fillResult() });
  await assert.rejects(handleAcroFormFillValidationRoute(accessor), { code: 'INVALID_ACROFORM_FILL_SAVE_OPTIONS', status: 400 });
  const malformed = context('acroform-validate', {
    profile: 'local-acroform-validation-v1', sourceSha256, values: { 'Account.Name': '' }, rules: { 'Account.Name': { pattern: '^A' } },
  }, { validate: async () => ({}) });
  await assert.rejects(handleAcroFormFillValidationRoute(malformed), { code: 'INVALID_ACROFORM_VALIDATION_OPTIONS', status: 400 });
});

test('AcroForm fill/save removes only a store-confirmed forged artifact', async () => {
  const body = { profile: 'local-acroform-fill-save-v1', sourceSha256, fieldName: 'Account.Name', value: 'Ada' };
  const forged = fillResult();
  forged.proof = { ...forged.proof, fieldNameSha256: 'f'.repeat(64) };
  let deleted = 0;
  const value = context('acroform-fill-save', body, { fill: async () => forged });
  value.store.getArtifact = async () => ({ id: artifactId, documentId, sha256: artifactSha256, operation: { type: 'pdf-acroform-fill-save', inputs: [{ documentId, sha256: sourceSha256 }], validation: { outputSha256: artifactSha256 } } });
  value.store.deleteArtifact = async () => { deleted += 1; };
  await assert.rejects(handleAcroFormFillValidationRoute(value), { code: 'ACROFORM_FILL_SAVE_RESULT_INVALID', status: 502 });
  assert.equal(deleted, 1);
});

test('AcroForm fill/save suppresses a disconnected response and revokes its artifact', async () => {
  const body = { profile: 'local-acroform-fill-save-v1', sourceSha256, fieldName: 'Account.Name', value: 'Ada' };
  let deleted = 0;
  const value = context('acroform-fill-save', body, { fill: async () => fillResult() });
  value.processing.signal = AbortSignal.abort(new Error('disconnected'));
  value.store.deleteArtifact = async () => { deleted += 1; };
  assert.equal(await handleAcroFormFillValidationRoute(value), true);
  assert.equal(deleted, 1);
  assert.equal(value.output.response, null);
});
