import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcroFormCheckboxEndpoints } from '../src/core/local-host-acroform-checkbox-endpoints.js';
import { createAcroFormRadioEndpoints } from '../src/core/local-host-acroform-radio-endpoints.js';
import { createAcroFormTextFieldEndpoints } from '../src/core/local-host-acroform-text-field-endpoints.js';

const digest = 'a'.repeat(64);
const rect = { x: 1, y: 2, width: 10, height: 10 };
function textResult(documentId, sourceSha256, request) {
  const artifactSha256 = 'b'.repeat(64); const operationId = '123e4567-e89b-42d3-a456-426614174001';
  const validators = ['source-sha256', 'private-source-copy', 'bounded-acroform-text-field-core', 'independent-text-field-reinspection', 'output-sha256'];
  const operation = { schemaVersion: 1, id: operationId, type: 'pdf-acroform-text-field', inputs: [{ documentId, sha256: sourceSha256, role: 'source' }], parameters: { profile: request.profile, fieldNameSha256: 'c'.repeat(64), page: request.page, rect: request.rect }, expected: { outputSha256: artifactSha256, sourcePrefixPreserved: true, defaultEmpty: true, signaturePreservation: false }, validation: { passed: true, validators, outputSha256: artifactSha256 }, completedAt: '2026-07-20T00:00:00.000Z' };
  return { artifact: { id: '123e4567-e89b-42d3-a456-426614174002', documentId, displayName: 'text-field-form.pdf', mediaType: 'application/pdf', size: 100, sha256: artifactSha256, operation, createdAt: '2026-07-20T00:00:00.000Z' }, proof: { profile: request.profile, sourceSha256, page: request.page, fieldNameSha256: operation.parameters.fieldNameSha256, rect: request.rect, sourcePrefixPreserved: true, defaultEmpty: true, objectCount: 4, references: { appearance: { object: 5, generation: 0 }, font: { object: 6, generation: 0 }, widget: { object: 7, generation: 0 }, acroForm: { object: 8, generation: 0 } }, otherPagesContentResourcesPreserved: true }, limitations: ['One empty passive terminal text field only; existing forms, widgets, signatures, encryption, tags, layers, actions, JavaScript, calculations, XFA, and unsupported PDF graphs are rejected.', 'The source document is preserved; no signature-preservation, PDF/A, or PDF/UA claim is made.'] };
}
test('AcroForm client endpoints use canonical authenticated requests', async () => {
  const calls = [];
  const json = async (path, options) => { calls.push({ path, options }); return { result: { ok: true } }; };
  const checkbox = createAcroFormCheckboxEndpoints({ json });
  await checkbox.addAcroFormCheckbox('123e4567-e89b-12d3-a456-426614174000', { profile: 'local-pdf-acroform-checkbox-v1', sourceSha256: digest, page: 1, fieldName: 'agree', rect });
  assert.equal(calls[0].path, '/api/documents/123e4567-e89b-12d3-a456-426614174000/acroform-checkbox');
  assert.deepEqual(JSON.parse(calls[0].options.body).rect, rect);
});
test('AcroForm radio client rejects duplicate labels and geometry', () => {
  const radio = createAcroFormRadioEndpoints({ json: async () => ({ result: null }) });
  const base = { profile: 'local-pdf-acroform-radio-v1', sourceSha256: digest, groupName: 'choice' };
  assert.throws(() => radio.addAcroFormRadio('123e4567-e89b-12d3-a456-426614174000', { ...base, options: [{ label: 'A', page: 1, rect }, { label: 'A', page: 2, rect: { ...rect, x: 20 } }] }), TypeError);
  assert.throws(() => radio.addAcroFormRadio('123e4567-e89b-12d3-a456-426614174000', { ...base, options: [{ label: 'A', page: 1, rect }, { label: 'B', page: 1, rect }] }), TypeError);
});
test('AcroForm text-field client validates provenance and freezes the result', async () => {
  const documentId = '123e4567-e89b-12d3-a456-426614174000'; const sourceSha256 = digest; const request = { profile: 'local-pdf-acroform-text-field-v1', sourceSha256, page: 1, fieldName: 'name', rect };
  const result = textResult(documentId, sourceSha256, request); const calls = [];
  const endpoint = createAcroFormTextFieldEndpoints({ json: async (path, options) => { calls.push({ path, options }); return { result }; } });
  const checked = await endpoint.addAcroFormTextField(documentId, request);
  assert.equal(calls[0].path, `/api/documents/${documentId}/acroform-text-field`); assert.equal(checked.artifact.displayName, 'text-field-form.pdf'); assert.equal(Object.isFrozen(checked), true); assert.equal(Object.isFrozen(checked.artifact.operation.validation.validators), true);
  const bad = textResult(documentId, sourceSha256, request); Object.defineProperty(bad.artifact.operation.validation.validators, '0', { get() { throw new Error('getter'); }, enumerable: true });
  const badEndpoint = createAcroFormTextFieldEndpoints({ json: async () => ({ result: bad }) });
  await assert.rejects(badEndpoint.addAcroFormTextField(documentId, request), /invalid/i);
});
