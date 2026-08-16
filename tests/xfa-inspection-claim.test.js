import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfXfaInspectionService } from '../scripts/host/pdf-xfa-inspection-service.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { invoke } from './support/host-router-fixture-base.js';
import { handleXfaInspectionRoute } from '../scripts/host/routes/xfa-inspection-routes.mjs';
import { createPdfXfaInspectionEndpoints } from '../src/core/local-host-xfa-inspection-endpoints.js';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { makeXfaInspectionPdf, xfaInspectionRequest } from './host-pdf-xfa-inspection-fixtures.mjs';

const ID = '11111111-1111-4111-8111-111111111111';

function context(body, service, signal = new AbortController().signal, documentId = ID) {
  const response = new EventEmitter();
  return {
    request: { method: 'POST' }, response, body, service,
    url: new URL(`http://local.test/api/documents/${documentId}/xfa-inspection`), documentId,
    operation: 'xfa-inspection', processing: { signal }, xfaInspection: service, bodyLimit: 2048,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)),
    method: (value, expected) => assert.equal(value.method, expected), readJson: async () => body,
    json: (_response, status, value) => { response.status = status; response.body = value; },
  };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'xfa-inspection-claim-'));
  const store = await new DocumentStore({ root }).initialize();
  t.after(() => store.dispose());
  const sourceBytes = makeXfaInspectionPdf({ acroFormXfa: true });
  const document = await store.createDocument({ stream: (async function* () { yield sourceBytes; }()), displayName: 'form.pdf' });
  return { store, document, request: xfaInspectionRequest(sourceBytes), service: new PdfXfaInspectionService({ store }) };
}

test('XFA inspection route and client are exact, authenticated-bound, and privacy minimal', async (t) => {
  const state = await setup(t);
  const routed = context(state.request, state.service, undefined, state.document.id);
  assert.equal(await handleXfaInspectionRoute(routed), true);
  assert.equal(routed.response.status, 200);
  assert.equal(routed.response.body.result.xfaPresent, true);
  assert.doesNotMatch(JSON.stringify(routed.response.body), /payload|5 0 R|\/XFA/u);
  let transport;
  const endpoints = createPdfXfaInspectionEndpoints({ json: async (path, options) => { transport = { path, options }; return structuredClone(routed.response.body); } });
  const signal = new AbortController().signal;
  const result = await endpoints.inspectXfaPresence(state.document.id, state.document.sha256, { signal });
  assert.equal(transport.path, `/api/documents/${state.document.id}/xfa-inspection`);
  assert.deepEqual(JSON.parse(transport.options.body), state.request);
  assert.equal(transport.options.signal, signal);
  assert.equal(Object.isFrozen(result), true);
  const calls = [];
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: 'a'.repeat(64) }), { status: 200 });
    return new Response(JSON.stringify(routed.response.body), { status: 200 });
  } });
  await client.bootstrap();
  assert.equal((await client.inspectXfaPresence(state.document.id, state.document.sha256)).xfaPresent, true);
  assert.equal(calls[1].path, `/api/documents/${state.document.id}/xfa-inspection`);
  assert.equal(calls[1].options.headers['X-Platen-Token'], 'a'.repeat(64));
  await assert.rejects(handleXfaInspectionRoute(context({ ...state.request, extra: true }, state.service)), { code: 'PDF_XFA_INSPECTION_OPTIONS_INVALID' });
  await assert.rejects(handleXfaInspectionRoute({ ...context(state.request, { inspect: async () => ({ kind: 'pdf-xfa-presence-inspection' }) }), url: new URL(`http://local.test/api/documents/${state.document.id}/xfa-inspection`) }), { code: 'PDF_XFA_INSPECTION_OUTPUT_INVALID' });
  const forged = structuredClone(routed.response.body.result);
  forged.proof.inspection = 'more-than-presence';
  await assert.rejects(createPdfXfaInspectionEndpoints({ json: async () => ({ result: forged }) }).inspectXfaPresence(state.document.id, state.document.sha256), { code: 'INVALID_LOCAL_HOST' });
});

test('XFA inspection is reachable through the authenticated application router', async (t) => {
  const state = await setup(t);
  const app = createAppHandler({
    staticHandler: () => {}, store: state.store, service: { availability: async () => [] }, workspaceState: {},
    xfaInspection: state.service, token: 'a'.repeat(64), host: '127.0.0.1', port: 4173,
  });
  const url = `/api/documents/${state.document.id}/xfa-inspection`;
  const headers = { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-platen-token': 'a'.repeat(64) };
  const accepted = await invoke(app, { method: 'POST', url, headers, body: JSON.stringify(state.request) });
  assert.equal(accepted.statusCode, 200);
  assert.equal(JSON.parse(accepted.body).result.xfaPresent, true);
  const denied = await invoke(app, { method: 'POST', url, headers: { origin: headers.origin, 'content-type': headers['content-type'] }, body: JSON.stringify(state.request) });
  assert.equal(denied.statusCode, 401);
});
