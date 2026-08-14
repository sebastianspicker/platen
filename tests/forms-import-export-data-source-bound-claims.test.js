import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { createAcroFormDataExportEndpoints } from '../src/core/local-host-acroform-data-export-endpoints.js';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfAcroFormDataExportService } from '../scripts/host/pdf-acroform-data-export-service.mjs';
import { createAcroFormDataExportResult, encodeAcroFormDataExportCsv, validateAcroFormDataExportResult as validateHostResult } from '../scripts/host/pdf-acroform-data-export-contract.mjs';
import { decodeStrictAcroFormExportString } from '../scripts/host/pdf-acroform-validation-core.mjs';
import { preparePdfAcroFormFillSave } from '../scripts/host/pdf-acroform-fill-save-writer.mjs';
import { preparePdfAcroFormTextField } from '../scripts/host/pdf-acroform-text-field-writer.mjs';
import { formFixture, digest as fixtureDigest } from '../scripts/host/professional-capability/fixtures.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { invoke } from './support/host-router-fixture-base.js';

const TOKEN = 'a'.repeat(64);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const request = (sourceSha256) => ({ profile: 'local-acroform-data-export-v1', sourceSha256 });
function textForm(value = 'Ada, "North"') {
  const source = formFixture();
  const authored = preparePdfAcroFormTextField(source, { profile: 'local-pdf-acroform-text-field-v1', sourceSha256: fixtureDigest(source), page: 1, fieldName: 'Account.Name', rect: { x: 72, y: 700, width: 180, height: 24 } }).bytes;
  return preparePdfAcroFormFillSave(authored, { profile: 'local-acroform-fill-save-v1', sourceSha256: digest(authored), fieldName: 'Account.Name', value }).bytes;
}
async function stateFor(t, sourceBytes = textForm()) {
  const root = await mkdtemp(join(tmpdir(), 'forms-import-export-data-')); const store = await new DocumentStore({ root }).initialize(); t.after(() => store.dispose());
  const document = await store.createDocument({ stream: (async function* () { yield sourceBytes; }()), displayName: 'source.pdf' });
  const app = createAppHandler({ staticHandler: () => {}, store, service: { availability: async () => [] }, workspaceState: {}, acroFormDataExport: new PdfAcroFormDataExportService({ store }), token: TOKEN, host: '127.0.0.1', port: 4173 });
  return { app, document, root, store, sourceBytes };
}
function appFetch(app) {
  return async (path, options = {}) => {
    const response = await invoke(app, { method: options.method ?? 'GET', url: path, headers: { origin: 'http://127.0.0.1:4173', ...(options.headers ?? {}), ...(options.headers?.['Content-Type'] ? { 'content-type': options.headers['Content-Type'] } : {}), ...(options.headers?.['X-Platen-Token'] ? { 'x-platen-token': options.headers['X-Platen-Token'] } : {}) }, body: options.body });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
}

test('forms.import-export-data exports exactly one bound terminal Tx value as canonical UTF-8 CSV without artifacts', async (t) => {
  const state = await stateFor(t); const sourceBefore = await readFile(state.store.getSourcePath(state.document.id));
  const client = new LocalHostClient({ fetchImpl: appFetch(state.app) }); await client.bootstrap();
  const result = await client.exportAcroFormData(state.document.id, request(state.document.sha256));
  assert.equal(result.kind, 'pdf-acroform-data-export'); assert.equal(result.sourceSha256, state.document.sha256); assert.equal(result.fieldCount, 1); assert.equal(result.localOnly, true);
  assert.equal(result.csv, '\ufefffieldName,currentValue\r\n"Account.Name","Ada, ""North"""\r\n'); assert.equal(result.csvSha256, digest(Buffer.from(result.csv, 'utf8')));
  assert.equal(result.fieldNameSha256, digest(Buffer.from('Account.Name'))); assert.equal(result.valueSha256, digest(Buffer.from('Ada, "North"')));
  assert.equal(JSON.stringify(result).includes('/private/'), false); assert.deepEqual(await readFile(state.store.getSourcePath(state.document.id)), sourceBefore);
  assert.deepEqual(await readdir(join(state.root, 'artifacts')), []); assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
  const unauthenticated = await invoke(state.app, { method: 'POST', url: `/api/documents/${state.document.id}/acroform-data-export`, headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' }, body: JSON.stringify(request(state.document.sha256)) });
  assert.equal(unauthenticated.statusCode, 401);
});

test('forms.import-export-data rejects stale, query, malformed, forged, passive-unsafe, and multifield sources', async (t) => {
  const state = await stateFor(t); const client = new LocalHostClient({ fetchImpl: appFetch(state.app) }); await client.bootstrap();
  await assert.rejects(client.exportAcroFormData(state.document.id, request('0'.repeat(64))), { code: 'SOURCE_VERSION_MISMATCH' });
  const query = await invoke(state.app, { method: 'POST', url: `/api/documents/${state.document.id}/acroform-data-export?q=1`, headers: { origin: 'http://127.0.0.1:4173', 'x-platen-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(request(state.document.sha256)) });
  assert.equal(query.statusCode, 400);
  const extra = await invoke(state.app, { method: 'POST', url: `/api/documents/${state.document.id}/acroform-data-export`, headers: { origin: 'http://127.0.0.1:4173', 'x-platen-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ ...request(state.document.sha256), import: 'forbidden' }) });
  assert.equal(extra.statusCode, 400);
  const multiple = Buffer.from(state.sourceBytes.toString('latin1').replace('/Fields [9 0 R]', '/Fields [9 0 R 9 0 R]'), 'latin1');
  const multipleState = await stateFor(t, multiple); const multipleClient = new LocalHostClient({ fetchImpl: appFetch(multipleState.app) }); await multipleClient.bootstrap();
  await assert.rejects(multipleClient.exportAcroFormData(multipleState.document.id, request(multipleState.document.sha256)), { code: 'ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED' });
  assert.deepEqual(await readdir(join(multipleState.root, 'jobs')), []);
  const unsafe = Buffer.from(state.sourceBytes.toString('latin1').replace('/AcroForm 10 0 R /Pages', '/AcroForm 10 0 R /XFA 11 0 R /Pages'), 'latin1');
  const unsafeState = await stateFor(t, unsafe); const unsafeClient = new LocalHostClient({ fetchImpl: appFetch(unsafeState.app) }); await unsafeClient.bootstrap();
  await assert.rejects(unsafeClient.exportAcroFormData(unsafeState.document.id, request(unsafeState.document.sha256)), { code: 'ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED' });
  assert.deepEqual(await readdir(join(unsafeState.root, 'jobs')), []);
  const catalogAction = Buffer.from(state.sourceBytes.toString('latin1').replace('/AcroForm 10 0 R /Pages', '/AcroForm 10 0 R /AA <<>> /Pages'), 'latin1');
  const actionState = await stateFor(t, catalogAction); const actionClient = new LocalHostClient({ fetchImpl: appFetch(actionState.app) }); await actionClient.bootstrap();
  await assert.rejects(actionClient.exportAcroFormData(actionState.document.id, request(actionState.document.sha256)), { code: 'ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED' });
  const nonPdfState = await stateFor(t, Buffer.from('%PDF-1.7\nnot a PDF structure', 'utf8')); const nonPdfClient = new LocalHostClient({ fetchImpl: appFetch(nonPdfState.app) }); await nonPdfClient.bootstrap();
  await assert.rejects(nonPdfClient.exportAcroFormData(nonPdfState.document.id, request(nonPdfState.document.sha256)), { code: 'ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED' });
  const oversized = new PdfAcroFormDataExportService({ store: { getDocument: () => ({ sha256: state.document.sha256, size: 32 * 1024 * 1024 + 1 }), getSourcePath: () => '', verifySource: async () => {}, createJobWorkspace: async () => '', cleanupJob: async () => {} } });
  await assert.rejects(oversized.export(state.document.id, request(state.document.sha256)), { code: 'ACROFORM_DATA_EXPORT_INPUT_TOO_LARGE' });
  const forged = { kind: 'pdf-acroform-data-export', sourceSha256: state.document.sha256, csv: '\ufefffieldName,currentValue\r\n"Account.Name","Ada"\r\n', csvSha256: '0'.repeat(64), fieldNameSha256: digest(Buffer.from('Account.Name')), valueSha256: digest(Buffer.from('Ada')), fieldCount: 1, limitations: ['Exports one existing terminal text field from an eligible passive classic AcroForm PDF as UTF-8 CSV.', 'No import, FDF, XFDF, XML, mutation, artifact, network, calculations, actions, XFA, or signatures are supported.'], localOnly: true };
  await assert.rejects(createAcroFormDataExportEndpoints({ json: async () => ({ result: forged }) }).exportAcroFormData(state.document.id, request(state.document.sha256)), /invalid/i);
  assert.throws(() => createAcroFormDataExportEndpoints({ json: async () => ({ result: forged }) }).exportAcroFormData(state.document.id, new Proxy(request(state.document.sha256), {})), /invalid/i);
});

test('forms.import-export-data cancellation removes its private workspace and preserves the source', async (t) => {
  const state = await stateFor(t); const controller = new AbortController(); const before = await readFile(state.store.getSourcePath(state.document.id)); const base = state.store;
  const wrapped = Object.fromEntries(['getDocument', 'getSourcePath', 'verifySource', 'cleanupJob'].map((name) => [name, base[name].bind(base)]));
  wrapped.createJobWorkspace = async (...args) => { const workspace = await base.createJobWorkspace(...args); controller.abort(); return workspace; };
  await assert.rejects(new PdfAcroFormDataExportService({ store: wrapped }).export(state.document.id, request(state.document.sha256), { signal: controller.signal }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(await readFile(base.getSourcePath(state.document.id)), before); assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
});

test('forms.import-export-data rejects unsafe source cells, strict PDF string failures, and malformed host results', async (t) => {
  const formula = await stateFor(t, textForm('  =SUM(A1:A2)')); const formulaClient = new LocalHostClient({ fetchImpl: appFetch(formula.app) }); await formulaClient.bootstrap();
  await assert.rejects(formulaClient.exportAcroFormData(formula.document.id, request(formula.document.sha256)), { code: 'ACROFORM_DATA_EXPORT_SOURCE_UNSUPPORTED' });
  for (const value of [' =1', '+1', '-1', '@x', 'a\tb', 'a\nb', 'a\u0080b', 'a\ufffdb', '\ud800']) assert.throws(() => encodeAcroFormDataExportCsv('Field', value), /invalid/i);
  assert.throws(() => decodeStrictAcroFormExportString({ type: 'string', bytes: Buffer.from([0xfe, 0xff, 0]) }), /odd|UTF-16/i);
  assert.throws(() => decodeStrictAcroFormExportString({ type: 'string', bytes: Buffer.from([0x80]) }), /printable/i);
  const sourceSha256 = formula.document.sha256; const valid = createAcroFormDataExportResult({ sourceSha256, fieldName: 'Field', currentValue: 'Ada' });
  for (const forged of [{ ...valid, csv: 1 }, { ...valid, csv: '\ufefffieldName,currentValue\r\n"Field"," =1"\r\n' }, { ...valid, limitations: new Proxy([...valid.limitations], {}) }]) {
    await assert.rejects(createAcroFormDataExportEndpoints({ json: async () => ({ result: forged }) }).exportAcroFormData(formula.document.id, request(sourceSha256)), /invalid|noncanonical/i);
  }
  const accessor = { ...valid, limitations: [...valid.limitations] }; Object.defineProperty(accessor.limitations, 0, { enumerable: true, get: () => valid.limitations[0] });
  await assert.rejects(createAcroFormDataExportEndpoints({ json: async () => ({ result: accessor }) }).exportAcroFormData(formula.document.id, request(sourceSha256)), /invalid/i);
  let getterCalls = 0; const getter = [...valid.limitations]; Object.defineProperty(getter, 0, { enumerable: true, get: () => { getterCalls += 1; return valid.limitations[0]; } });
  const hole = [...valid.limitations]; delete hole[1]; const named = [...valid.limitations]; delete named[1]; named.foo = valid.limitations[1]; const symbol = [...valid.limitations]; symbol[Symbol('extra')] = true;
  for (const limitations of [hole, named, getter, symbol]) {
    const forged = { ...valid, limitations }; assert.equal(validateHostResult(forged, { sourceSha256 }), false);
    await assert.rejects(createAcroFormDataExportEndpoints({ json: async () => ({ result: forged }) }).exportAcroFormData(formula.document.id, request(sourceSha256)), /invalid/i);
  }
  assert.equal(getterCalls, 0);
});

test('forms.import-export-data aggregates cleanup failure with the original operation failure', async (t) => {
  const state = await stateFor(t); const base = state.store; const wrapped = Object.fromEntries(['getDocument', 'verifySource', 'createJobWorkspace'].map((name) => [name, base[name].bind(base)]));
  wrapped.getSourcePath = () => { throw new Error('operation failure'); }; wrapped.cleanupJob = async () => { throw new Error('cleanup failure'); };
  await assert.rejects(new PdfAcroFormDataExportService({ store: wrapped }).export(state.document.id, request(state.document.sha256)), (error) => error.code === 'ACROFORM_DATA_EXPORT_CLEANUP_FAILED' && error.cause instanceof AggregateError && error.cause.errors.length === 2);
});

test('forms.import-export-data rejects descriptor-hostile options and source drift after inspection', async (t) => {
  const state = await stateFor(t); const service = new PdfAcroFormDataExportService({ store: state.store });
  await assert.rejects(service.export(state.document.id, request(state.document.sha256), new Proxy({}, {})), /options/i);
  const accessor = {}; Object.defineProperty(accessor, 'signal', { enumerable: true, get: () => new AbortController().signal });
  await assert.rejects(service.export(state.document.id, request(state.document.sha256), accessor), /options/i);
  let checks = 0; const base = state.store; const wrapped = Object.fromEntries(['getDocument', 'getSourcePath', 'createJobWorkspace', 'cleanupJob'].map((name) => [name, base[name].bind(base)]));
  wrapped.verifySource = async (...args) => { checks += 1; if (checks > 1) { const error = new Error('source drift'); error.code = 'SOURCE_VERSION_MISMATCH'; throw error; } return base.verifySource(...args); };
  await assert.rejects(new PdfAcroFormDataExportService({ store: wrapped }).export(state.document.id, request(state.document.sha256)), { code: 'SOURCE_VERSION_MISMATCH' });
  assert.deepEqual(await readdir(join(state.root, 'jobs')), []);
});
