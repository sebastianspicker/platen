import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { createAcroFormFillValidationEndpoints } from '../src/core/local-host-acroform-fill-validation-endpoints.js';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormFillSaveService } from '../scripts/host/pdf-acroform-fill-save-service.mjs';
import { PdfAcroFormValidationService } from '../scripts/host/pdf-acroform-validation-service.mjs';
import { preparePdfAcroFormCheckbox } from '../scripts/host/pdf-acroform-checkbox-writer.mjs';
import { inspectPdfAcroFormFillSave } from '../scripts/host/pdf-acroform-fill-save-writer.mjs';
import { preparePdfAcroFormSignatureField } from '../scripts/host/pdf-acroform-signature-field-writer.mjs';
import { preparePdfAcroFormTextField } from '../scripts/host/pdf-acroform-text-field-writer.mjs';
import { formFixture, digest as fixtureDigest } from '../scripts/host/professional-capability/fixtures.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { invoke } from './support/host-router-fixture-base.js';

const TOKEN = 'a'.repeat(64);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const textRequest = (sourceSha256, value = 'Ada') => ({ profile: 'local-acroform-fill-save-v1', sourceSha256, fieldName: 'Account.Name', value });
const validationRequest = (sourceSha256, values = { 'Account.Name': '' }, rules = { 'Account.Name': { required: true, minLength: 3 } }) => ({ profile: 'local-acroform-validation-v1', sourceSha256, values, rules });

function textForm() {
  const source = formFixture();
  return preparePdfAcroFormTextField(source, {
    profile: 'local-pdf-acroform-text-field-v1', sourceSha256: fixtureDigest(source), page: 1,
    fieldName: 'Account.Name', rect: { x: 72, y: 700, width: 180, height: 24 },
  }).bytes;
}

function checkboxForm() {
  const source = formFixture();
  return preparePdfAcroFormCheckbox(source, {
    profile: 'local-pdf-acroform-checkbox-v1', sourceSha256: fixtureDigest(source), page: 1,
    fieldName: 'Approval', rect: { x: 72, y: 650, width: 24, height: 24 },
  }).bytes;
}

async function stateFor(t, sourceBytes = textForm(), displayName = 'source.pdf') {
  const root = await mkdtemp(join(tmpdir(), 'forms-fill-validation-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const document = await store.createDocument({ stream: (async function* () { yield sourceBytes; }()), displayName });
  const app = createAppHandler({
    staticHandler: () => {}, store, service: { availability: async () => [] }, workspaceState: {},
    acroFormFillSave: new PdfAcroFormFillSaveService({ store }),
    acroFormValidation: new PdfAcroFormValidationService({ store }),
    token: TOKEN, host: '127.0.0.1', port: 4173,
  });
  return { app, document, root, store, sourceBytes };
}

function appFetch(app) {
  return async (path, options = {}) => {
    const response = await invoke(app, {
      method: options.method ?? 'GET',
      url: path,
      headers: {
        origin: 'http://127.0.0.1:4173',
        ...(options.headers ?? {}),
        ...(options.headers?.['Content-Type'] ? { 'content-type': options.headers['Content-Type'] } : {}),
        ...(options.headers?.['X-Platen-Token'] ? { 'x-platen-token': options.headers['X-Platen-Token'] } : {}),
      },
      body: options.body,
    });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
}

test('forms.fill-save updates one existing field through the authenticated route and independently reopens V/AS', async (t) => {
  const state = await stateFor(t);
  const sourceBefore = await readFile(state.store.getSourcePath(state.document.id));
  const client = new LocalHostClient({ fetchImpl: appFetch(state.app) });
  await client.bootstrap();
  const request = textRequest(state.document.sha256);
  const result = await client.fillAndSaveAcroForm(state.document.id, request);
  assert.equal(result.kind, 'pdf-acroform-fill-save');
  assert.equal(result.proof.fieldType, 'text');
  assert.equal(result.proof.sourcePrefixPreserved, true);
  assert.equal(result.proof.semanticValueValidated, true);
  assert.equal(result.artifact.documentId, state.document.id);
  assert.notEqual(result.artifact.id, state.document.id);
  assert.equal(Object.hasOwn(result.artifact, 'filePath'), false);
  const publicReceipt = JSON.stringify(result);
  assert.equal(publicReceipt.includes(request.fieldName), false);
  assert.equal(publicReceipt.includes(request.value), false);
  assert.equal(publicReceipt.includes('/private/'), false);

  const retained = state.store.getArtifact(result.artifact.id);
  const output = await readFile(retained.filePath);
  assert.equal(digest(output), result.artifact.sha256);
  assert.equal(output.subarray(0, sourceBefore.length).equals(sourceBefore), true);
  assert.deepEqual(inspectPdfAcroFormFillSave(sourceBefore, output, request), result.proof);
  assert.deepEqual(await readFile(state.store.getSourcePath(state.document.id)), sourceBefore);
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);

  const unauthenticated = await invoke(state.app, {
    method: 'POST', url: `/api/documents/${state.document.id}/acroform-fill-save`,
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' }, body: JSON.stringify(request),
  });
  assert.equal(unauthenticated.statusCode, 401);
});

test('forms.validate is deterministic, read-only, source-bound, and hashes every field identifier', async (t) => {
  const state = await stateFor(t);
  const client = new LocalHostClient({ fetchImpl: appFetch(state.app) });
  await client.bootstrap();
  const before = await readFile(state.store.getSourcePath(state.document.id));
  const request = validationRequest(state.document.sha256);
  const first = await client.validateAcroFormValues(state.document.id, request);
  const second = await client.validateAcroFormValues(state.document.id, request);
  assert.deepEqual(first, second);
  assert.equal(first.kind, 'pdf-acroform-validation');
  assert.equal(first.sourceDigest, state.document.sha256);
  assert.equal(first.fieldCount, 1);
  assert.equal(first.valid, false);
  assert.deepEqual(first.errors, [{ fieldNameSha256: digest(Buffer.from('Account.Name')), code: 'REQUIRED' }]);
  assert.equal(JSON.stringify(first).includes('Account.Name'), false);
  assert.equal(JSON.stringify(first).includes('Ada'), false);
  assert.equal(first.localOnly, true);
  assert.deepEqual(await readFile(state.store.getSourcePath(state.document.id)), before);
  assert.deepEqual(await readdir(join(state.root, 'artifacts')), []);
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);

  const min = await client.validateAcroFormValues(state.document.id, validationRequest(state.document.sha256, { 'Account.Name': 'A' }, { 'Account.Name': { minLength: 3 } }));
  const max = await client.validateAcroFormValues(state.document.id, validationRequest(state.document.sha256, { 'Account.Name': 'ABCD' }, { 'Account.Name': { maxLength: 3 } }));
  assert.equal(min.errors[0].code, 'MIN_LENGTH');
  assert.equal(max.errors[0].code, 'MAX_LENGTH');

  const checkbox = await stateFor(t, checkboxForm(), 'checkbox.pdf');
  const checkboxClient = new LocalHostClient({ fetchImpl: appFetch(checkbox.app) });
  await checkboxClient.bootstrap();
  const type = await checkboxClient.validateAcroFormValues(checkbox.document.id, validationRequest(checkbox.document.sha256, { Approval: true }, { Approval: { type: 'string' } }));
  assert.deepEqual(type.errors, [{ fieldNameSha256: digest(Buffer.from('Approval')), code: 'TYPE' }]);
});

test('forms.fill-save and forms.validate reject stale, unknown, ambiguous, regex, unsupported, and forged inputs', async (t) => {
  const state = await stateFor(t);
  const client = new LocalHostClient({ fetchImpl: appFetch(state.app) });
  await client.bootstrap();
  const fill = textRequest(state.document.sha256);
  const valid = await client.fillAndSaveAcroForm(state.document.id, fill);
  await assert.rejects(client.fillAndSaveAcroForm(state.document.id, { ...fill, sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });
  await assert.rejects(client.validateAcroFormValues(state.document.id, validationRequest(state.document.sha256, { Missing: 'Ada' }, {})), { code: 'ACROFORM_VALIDATION_FIELD_NOT_FOUND' });
  const regexRequest = validationRequest(state.document.sha256, { 'Account.Name': 'Ada' }, { 'Account.Name': { pattern: '^A' } });
  assert.throws(() => client.validateAcroFormValues(state.document.id, regexRequest), /regex|invalid/i);
  const regexResponse = await invoke(state.app, {
    method: 'POST', url: `/api/documents/${state.document.id}/acroform-validate`,
    headers: { origin: 'http://127.0.0.1:4173', 'x-platen-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(regexRequest),
  });
  assert.equal(regexResponse.statusCode, 400);
  assert.equal(JSON.parse(regexResponse.body).error.code, 'INVALID_ACROFORM_VALIDATION_OPTIONS');

  const forged = structuredClone(valid);
  forged.artifact.operation.validation.outputSha256 = '0'.repeat(64);
  const forgedEndpoints = createAcroFormFillValidationEndpoints({ json: async () => ({ result: forged }) });
  await assert.rejects(forgedEndpoints.fillAndSaveAcroForm(state.document.id, fill), /invalid/i);
  const forgedValidation = {
    kind: 'pdf-acroform-validation', sourceDigest: state.document.sha256, fieldCount: 1, valid: false,
    errors: [{ fieldNameSha256: 'b'.repeat(64), code: 'REQUIRED', value: 'Account.Name' }], limitations: ['bounded'], localOnly: true,
  };
  const forgedValidationEndpoints = createAcroFormFillValidationEndpoints({ json: async () => ({ result: forgedValidation }) });
  await assert.rejects(forgedValidationEndpoints.validateAcroFormValues(state.document.id, validationRequest(state.document.sha256)), /invalid/i);

  const unsupportedSources = [
    ['ambiguous field aliases', (bytes) => bytes.toString('latin1').replace('/Fields [9 0 R]', '/Fields [9 0 R 9 0 R]')],
    ['XFA', (bytes) => bytes.toString('latin1').replace('/AcroForm 10 0 R /Pages', '/AcroForm 10 0 R /XFA 11 0 R /Pages')],
    ['actions', (bytes) => bytes.toString('latin1').replace('/AcroForm 10 0 R /Pages', '/AcroForm 10 0 R /OpenAction 11 0 R /Pages')],
    ['calculations', (bytes) => bytes.toString('latin1').replace('/DA <2F48656C7620313220546620302067> /DR', '/DA <2F48656C7620313220546620302067> /CO [] /DR')],
  ];
  for (const [label, transform] of unsupportedSources) {
    const bytes = Buffer.from(transform(textForm()), 'latin1');
    const unsupported = await stateFor(t, bytes, `${label}.pdf`);
    const unsupportedClient = new LocalHostClient({ fetchImpl: appFetch(unsupported.app) });
    await unsupportedClient.bootstrap();
    await assert.rejects(unsupportedClient.validateAcroFormValues(unsupported.document.id, validationRequest(unsupported.document.sha256)), { code: 'ACROFORM_VALIDATION_SOURCE_UNSUPPORTED' }, label);
    await assert.rejects(unsupportedClient.fillAndSaveAcroForm(unsupported.document.id, textRequest(unsupported.document.sha256)), { code: 'ACROFORM_FILL_SAVE_SOURCE_UNSUPPORTED' }, label);
  }

  const signatureSource = preparePdfAcroFormSignatureField(formFixture(), { profile: 'local-pdf-acroform-signature-field-v1', sourceSha256: fixtureDigest(formFixture()), page: 1, fieldName: 'Signed', rect: { x: 72, y: 700, width: 180, height: 24 } }).bytes;
  const signature = await stateFor(t, signatureSource, 'signature.pdf');
  const signatureClient = new LocalHostClient({ fetchImpl: appFetch(signature.app) });
  await signatureClient.bootstrap();
  await assert.rejects(signatureClient.validateAcroFormValues(signature.document.id, validationRequest(signature.document.sha256, { Signed: '' }, {})), { code: 'ACROFORM_VALIDATION_SOURCE_UNSUPPORTED' });
});

test('forms.fill-save cancellation revokes the promoted artifact and leaves the source unchanged', async (t) => {
  const state = await stateFor(t);
  const controller = new AbortController();
  let promotedId;
  const base = state.store;
  const wrapped = {};
  for (const name of ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'deleteArtifact']) wrapped[name] = base[name].bind(base);
  wrapped.promotePdfArtifact = async (...args) => {
    const artifact = await base.promotePdfArtifact(...args);
    promotedId = artifact.id;
    controller.abort();
    return artifact;
  };
  const sourceBefore = await readFile(base.getSourcePath(state.document.id));
  const service = new PdfAcroFormFillSaveService({ store: wrapped });
  await assert.rejects(service.fill(state.document.id, textRequest(state.document.sha256), { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.throws(() => base.getArtifact(promotedId), { code: 'ARTIFACT_NOT_FOUND' });
  assert.deepEqual(await readFile(base.getSourcePath(state.document.id)), sourceBefore);
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
});
