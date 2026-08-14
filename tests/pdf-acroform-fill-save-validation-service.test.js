import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { preparePdfAcroFormTextField } from '../scripts/host/pdf-acroform-text-field-writer.mjs';
import { preparePdfAcroFormChoice } from '../scripts/host/pdf-acroform-choice-writer.mjs';
import { preparePdfAcroFormCheckbox } from '../scripts/host/pdf-acroform-checkbox-writer.mjs';
import { preparePdfAcroFormRadio } from '../scripts/host/pdf-acroform-radio-writer.mjs';
import { inspectPdfAcroFormFillSave } from '../scripts/host/pdf-acroform-fill-save-writer.mjs';
import { PdfAcroFormFillSaveService } from '../scripts/host/pdf-acroform-fill-save-service.mjs';
import { PdfAcroFormValidationService, PDF_ACROFORM_VALIDATION_PROFILE } from '../scripts/host/pdf-acroform-validation-service.mjs';
import { formFixture } from '../scripts/host/professional-capability/fixtures.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function filledSource() { const source = formFixture(); return preparePdfAcroFormTextField(source, { profile: 'local-pdf-acroform-text-field-v1', sourceSha256: digest(source), page: 1, fieldName: 'Account.Name', rect: { x: 72, y: 700, width: 180, height: 24 } }).bytes; }
async function setup(context) { const root = await mkdtemp('/private/tmp/pdf-acroform-fill-save-'); const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose()); const bytes = filledSource(); const document = await store.createDocument({ stream: (async function* () { yield bytes; }()), displayName: 'form.pdf' }); return { store, bytes, document }; }
function fillRequest(bytes) { return { profile: 'local-acroform-fill-save-v1', sourceSha256: digest(bytes), fieldName: 'Account.Name', value: 'Ada' }; }
function validationRequest(bytes, values = { 'Account.Name': '' }, rules = { 'Account.Name': { minLength: 3 } }) { return { profile: PDF_ACROFORM_VALIDATION_PROFILE, sourceSha256: digest(bytes), values, rules }; }
function authored(kind) {
  const source = formFixture(); const sourceSha256 = digest(source);
  if (kind === 'choice') return { bytes: preparePdfAcroFormChoice(source, { profile: 'local-pdf-acroform-choice-v1', sourceSha256, page: 1, fieldName: 'Choice', rect: { x: 10, y: 700, width: 100, height: 20 }, options: [{ label: 'First' }, { label: 'Second' }] }).bytes, fieldName: 'Choice', value: 'First' };
  if (kind === 'checkbox') return { bytes: preparePdfAcroFormCheckbox(source, { profile: 'local-pdf-acroform-checkbox-v1', sourceSha256, page: 1, fieldName: 'Approve', rect: { x: 10, y: 700, width: 20, height: 20 } }).bytes, fieldName: 'Approve', value: true };
  return { bytes: preparePdfAcroFormRadio(source, { profile: 'local-pdf-acroform-radio-v1', sourceSha256, groupName: 'Radio', options: [{ label: 'First', page: 1, rect: { x: 10, y: 700, width: 20, height: 20 } }, { label: 'Second', page: 1, rect: { x: 40, y: 700, width: 20, height: 20 } }] }).bytes, fieldName: 'Radio', value: 'Opt1' };
}

test('fill/save service promotes a privacy-minimal independently reopened derived artifact', async (context) => {
  const value = await setup(context); const result = await new PdfAcroFormFillSaveService({ store: value.store }).fill(value.document.id, fillRequest(value.bytes));
  assert.deepEqual(Object.keys(result).sort(), ['artifact', 'kind', 'limitations', 'proof']); assert.equal(result.kind, 'pdf-acroform-fill-save'); assert.equal(result.proof.fieldType, 'text'); assert.equal(result.proof.sourcePrefixPreserved, true); assert.equal(result.proof.semanticValueValidated, true); assert.match(result.proof.fieldNameSha256, /^[0-9a-f]{64}$/u); assert.match(result.proof.valueSha256, /^[0-9a-f]{64}$/u); assert.equal(JSON.stringify(result).includes('Account.Name'), false); assert.equal(JSON.stringify(result).includes('Ada'), false); assert.deepEqual(await readdir(`${value.store.root}/jobs`), []);
});

test('fill/save service rejects source mismatch, accessors, proxies, and cancellation before publication', async (context) => {
  const value = await setup(context); const service = new PdfAcroFormFillSaveService({ store: value.store });
  await assert.rejects(service.fill(value.document.id, { ...fillRequest(value.bytes), sourceSha256: '0'.repeat(64) }), { code: 'SOURCE_VERSION_MISMATCH' });
  const accessor = fillRequest(value.bytes); Object.defineProperty(accessor, 'value', { enumerable: true, get() { throw new Error('read'); } });
  await assert.rejects(service.fill(value.document.id, accessor), { code: 'INVALID_ACROFORM_FILL_SAVE_OPTIONS' });
  await assert.rejects(service.fill(value.document.id, new Proxy(fillRequest(value.bytes), {})), { code: 'INVALID_ACROFORM_FILL_SAVE_OPTIONS' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.fill(value.document.id, fillRequest(value.bytes), { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  const revoked = []; const names = ['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'promotePdfArtifact'];
  const cleanupStore = Object.fromEntries(names.map((name) => [name, value.store[name].bind(value.store)]));
  cleanupStore.cleanupJob = async (...args) => { await value.store.cleanupJob(...args); throw new Error('cleanup'); };
  cleanupStore.deleteArtifact = async (id) => { revoked.push(id); await value.store.deleteArtifact(id); };
  await assert.rejects(new PdfAcroFormFillSaveService({ store: cleanupStore }).fill(value.document.id, fillRequest(value.bytes)), { code: 'ACROFORM_FILL_SAVE_CLEANUP_FAILED' });
  assert.equal(revoked.length, 1);
});

test('fill/save independently reopens bounded choice, checkbox, and radio sources', async (context) => {
  for (const kind of ['choice', 'checkbox', 'radio']) {
    const input = authored(kind); const root = await mkdtemp(`/private/tmp/pdf-acroform-fill-${kind}-`);
    const store = await new DocumentStore({ root }).initialize(); context.after(() => store.dispose());
    const document = await store.createDocument({ stream: (async function* () { yield input.bytes; }()), displayName: `${kind}.pdf` });
    const request = { profile: 'local-acroform-fill-save-v1', sourceSha256: digest(input.bytes), fieldName: input.fieldName, value: input.value };
    const result = await new PdfAcroFormFillSaveService({ store }).fill(document.id, request);
    assert.equal(result.proof.fieldType, kind); assert.equal(Object.hasOwn(result.artifact, 'filePath'), false);
    const artifact = store.getArtifact(result.artifact.id); const output = await (await import('node:fs/promises')).readFile(artifact.filePath);
    assert.deepEqual(inspectPdfAcroFormFillSave(input.bytes, output, request), Object.fromEntries(Object.entries(result.proof).filter(([key]) => key !== 'outputSha256')));
    await assert.rejects(new PdfAcroFormFillSaveService({ store }).fill(document.id, { ...request, value: kind === 'checkbox' ? 'yes' : 'Missing' }), { code: 'INVALID_ACROFORM_FILL_SAVE_OPTIONS' });
  }
});

test('read-only validation rejects regex and returns deterministic value-free errors', async (context) => {
  const value = await setup(context); const service = new PdfAcroFormValidationService({ store: value.store }); const result = await service.validate(value.document.id, validationRequest(value.bytes));
  assert.deepEqual(Object.keys(result).sort(), ['errors', 'fieldCount', 'kind', 'limitations', 'localOnly', 'sourceDigest', 'valid']);
  assert.equal(result.kind, 'pdf-acroform-validation'); assert.equal(result.fieldCount, 1); assert.equal(result.valid, false);
  assert.deepEqual(Object.keys(result.errors[0]).sort(), ['code', 'fieldNameSha256']);
  assert.equal(JSON.stringify(result).includes('Account.Name'), false); assert.equal(JSON.stringify(result).includes('Ada'), false);
  await assert.rejects(service.validate(value.document.id, validationRequest(value.bytes, { 'Account.Name': 'Ada' }, { 'Account.Name': { pattern: '^A' } })), { code: 'INVALID_ACROFORM_VALIDATION_OPTIONS' });
  const nestedAccessor = validationRequest(value.bytes); Object.defineProperty(nestedAccessor.rules['Account.Name'], 'required', { enumerable: true, get() { throw new Error('read'); } });
  await assert.rejects(service.validate(value.document.id, nestedAccessor), { code: 'INVALID_ACROFORM_VALIDATION_OPTIONS' });
  await assert.rejects(service.validate(value.document.id, validationRequest(value.bytes, { Unknown: 'Ada' }, {})), { code: 'ACROFORM_VALIDATION_FIELD_NOT_FOUND' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.validate(value.document.id, validationRequest(value.bytes), { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  await assert.rejects(service.validate(value.document.id, new Proxy(validationRequest(value.bytes), {})), { code: 'INVALID_ACROFORM_VALIDATION_OPTIONS' });
  assert.deepEqual(await readdir(`${value.store.root}/jobs`), []);
});
