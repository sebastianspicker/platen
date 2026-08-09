import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfFormJavaScriptInventoryService } from '../scripts/host/pdf-form-javascript-service.mjs';
import { handleFormJavaScriptInventoryRoute } from '../scripts/host/routes/form-javascript-inventory-routes.mjs';
import { createFormJavaScriptInventoryEndpoints } from '../src/core/local-host-form-javascript-inventory-endpoints.js';
import { formJavaScriptRequest, makeFormJavaScriptPdf } from './host-pdf-form-javascript-fixtures.mjs';

const ID = '11111111-1111-4111-8111-111111111111';

function context(body, service, signal = new AbortController().signal, documentId = ID) {
  const response = new EventEmitter();
  return {
    request: { method: 'POST' }, response, body, service,
    url: new URL(`http://local.test/api/documents/${documentId}/form-javascript-inventory`), documentId,
    operation: 'form-javascript-inventory', processing: { signal }, formJavaScriptInventory: service,
    bodyLimit: 2048,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length
      && Object.keys(value).every((key) => keys.includes(key)),
    method: (value, expected) => assert.equal(value.method, expected), readJson: async () => body,
    json: (_response, status, value) => { response.status = status; response.body = value; },
  };
}

async function setup(t) {
  const root = await mkdtemp('/private/tmp/form-javascript-claim-');
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const sourceBytes = makeFormJavaScriptPdf({ actions: [
    { trigger: 'K', script: 'event.rc = true;' }, { trigger: 'F', script: 'event.value = event.value;' },
    { trigger: 'V', script: 'event.rc = event.value !== "";' }, { trigger: 'C', script: 'event.value = 1;' },
  ] });
  const document = await store.createDocument({ stream: (async function* () { yield sourceBytes; }()), displayName: 'form.pdf' });
  return { store, sourceBytes, document, request: formJavaScriptRequest(sourceBytes), service: new PdfFormJavaScriptInventoryService({ store }) };
}

test('form JavaScript action inventory is bounded, source-bound, private, and read-only across route and client', async (t) => {
  const state = await setup(t); const before = createHash('sha256').update(state.sourceBytes).digest('hex');
  const routed = context(state.request, state.service, undefined, state.document.id);
  assert.equal(await handleFormJavaScriptInventoryRoute(routed), true);
  assert.equal(routed.response.status, 200);
  assert.deepEqual(routed.response.body.result.report.actionLoci.map(({ trigger }) => trigger), ['keystroke', 'format', 'validate', 'calculate']);
  assert.equal(routed.response.body.result.report.rawScriptTextIncluded, false);
  assert.equal(routed.response.body.result.report.activeContentExecuted, false);
  assert.equal(JSON.stringify(routed.response.body).includes('event.rc'), false);
  const signal = new AbortController().signal; let transport;
  const endpoints = createFormJavaScriptInventoryEndpoints({ json: async (path, options) => { transport = { path, options }; return structuredClone(routed.response.body); } });
  const result = await endpoints.inspectFormJavaScriptInventory(state.document.id, state.document.sha256, { signal });
  assert.equal(transport.path, `/api/documents/${state.document.id}/form-javascript-inventory`);
  assert.equal(JSON.parse(transport.options.body).profile, state.request.profile); assert.equal(transport.options.signal, signal);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.report), true); assert.equal(Object.isFrozen(result.report.actionLoci), true);
  assert.equal(createHash('sha256').update(await readFile(state.store.getSourcePath(state.document.id))).digest('hex'), before);
});

test('form JavaScript route forwards cancellation and rejects forged reports and request drift', async (t) => {
  const state = await setup(t); const controller = new AbortController(); let observed;
  const service = { inspect: async (...args) => { observed = args; return state.service.inspect(...args); } };
  const routed = context(state.request, service, controller.signal, state.document.id); assert.equal(await handleFormJavaScriptInventoryRoute(routed), true);
  assert.equal(observed[2].signal, controller.signal);
  await assert.rejects(handleFormJavaScriptInventoryRoute(context({ ...state.request, extra: true }, service, undefined, state.document.id)), { code: 'PDF_FORM_JAVASCRIPT_OPTIONS_INVALID' });
  const forged = structuredClone(routed.response.body.result); forged.report.actionLoci[0].scriptText = 'event.rc = true;';
  await assert.rejects(createFormJavaScriptInventoryEndpoints({ json: async () => ({ result: forged }) }).inspectFormJavaScriptInventory(state.document.id, state.document.sha256), { code: 'INVALID_LOCAL_HOST' });
  controller.abort(); await assert.rejects(state.service.inspect(state.document.id, state.request, { signal: controller.signal }), { code: 'JOB_CANCELLED' });
});
