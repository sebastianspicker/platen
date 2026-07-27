import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleAcroFormCheckboxRoute, handleAcroFormRadioRoute, handleAcroFormTextFieldRoute } from '../scripts/host/routes/acroform-routes.mjs';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';

const digest = 'a'.repeat(64);
const rect = { x: 1, y: 2, width: 10, height: 10 };
function context(kind, body) {
  const response = new EventEmitter(); const calls = [];
  const base = { request: { method: 'POST' }, response, url: new URL(`http://local/api/documents/doc/acroform-${kind}`), documentId: 'doc', operation: `acroform-${kind}`, processing: { signal: new AbortController().signal }, store: {}, bodyLimit: 16384, exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)), method: (request, expected) => assert.equal(request.method, expected), readJson: async () => body, json: (_response, status, value) => { response.status = status; response.value = value; }, calls };
  base[kind === 'checkbox' ? 'acroFormCheckbox' : kind === 'radio' ? 'acroFormRadio' : 'acroFormTextField'] = { add: async (...args) => { calls.push(args); return { artifact: { id: 'a' }, limitations: [] }; } };
  return base;
}
test('AcroForm routes authenticate operation shape and forward source binding', async () => {
  const checkbox = context('checkbox', { profile: 'local-pdf-acroform-checkbox-v1', sourceSha256: digest, page: 1, fieldName: 'agree', rect });
  assert.equal(await handleAcroFormCheckboxRoute(checkbox), true); assert.equal(checkbox.response.status, 201); assert.equal(checkbox.calls[0][1].sourceSha256, digest);
  const radio = context('radio', { profile: 'local-pdf-acroform-radio-v1', sourceSha256: digest, groupName: 'choice', options: [{ label: 'A', page: 1, rect }, { label: 'B', page: 1, rect: { ...rect, x: 20 } }] });
  assert.equal(await handleAcroFormRadioRoute(radio), true);
  const text = context('text-field', { profile: 'local-pdf-acroform-text-field-v1', sourceSha256: digest, page: 1, fieldName: 'name', rect: { x: 1, y: 2, width: 100, height: 20 } });
  assert.equal(await handleAcroFormTextFieldRoute(text), true); assert.equal(text.response.status, 201); assert.equal(text.calls[0][1].fieldName, 'name');
  await assert.rejects(handleAcroFormRadioRoute(context('radio', { ...radio.readJson, profile: 'wrong' })), { code: 'INVALID_ACROFORM_RADIO_OPTIONS' });
});
test('bootstrap advertises both AcroForm readiness capabilities', async () => {
  const response = {}; await handleBootstrapRoute({ pathname: '/api/bootstrap', request: {}, response, service: { availability: async () => [] }, acroFormCheckbox: {}, acroFormRadio: {}, acroFormTextField: {}, token: 't', method: () => {}, requireLocalFetchMetadata: () => {}, sanitizedEngineAvailability: (x) => x, json: (_r, _s, value) => Object.assign(response, value) });
  assert.equal(response.host.acroFormCheckboxReady, true); assert.equal(response.host.acroFormRadioReady, true); assert.equal(response.host.acroFormTextFieldReady, true);
});
