import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfTextReflowService } from '../scripts/host/pdf-text-reflow-service.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { handleTextReflowRoute } from '../scripts/host/routes/text-reflow-routes.mjs';
import { makeTextReflowPdf, textReflowRequest } from './host-pdf-text-reflow-fixtures.mjs';
import { invoke } from './support/host-router-fixture-base.js';

async function setup(t) {
  const store = await new DocumentStore({ root: await mkdtemp('/private/tmp/text-reflow-route-') }).initialize();
  t.after(() => store.dispose());
  const bytes = makeTextReflowPdf();
  const document = await store.createDocument({
    stream: (async function* () { yield bytes; }()),
    displayName: 'source.pdf',
  });
  return { store, document, request: textReflowRequest(bytes), textReflow: new PdfTextReflowService({ store }) };
}

function context(state, body = state.request, { aborted = false, destroyed = false } = {}) {
  const response = new EventEmitter();
  response.destroyed = destroyed;
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    request: { method: 'POST' },
    response,
    url: new URL(`http://local.test/api/documents/${state.document.id}/text-reflow`),
    documentId: state.document.id,
    operation: 'text-reflow',
    processing: { signal: controller.signal },
    store: state.store,
    textReflow: state.textReflow,
    bodyLimit: 128 * 1024,
    exactJsonObject(value, keys) {
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype
        && Reflect.ownKeys(value).length === keys.length
        && Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key));
    },
    method(request, expected) { assert.equal(request.method, expected); },
    readJson: async () => body,
    json(_response, status, value) { response.status = status; response.value = value; },
  };
}

test('text-reflow route validates the current source and returns a retained result', async (t) => {
  const state = await setup(t);
  const value = context(state);
  assert.equal(await handleTextReflowRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.equal(value.response.value.result.kind, 'pdf-text-reflow');
  assert.equal(value.response.value.result.artifact.documentId, state.document.id);
  await state.store.deleteArtifact(value.response.value.result.artifact.id);
});

test('text-reflow route rejects extra fields and stale source digests', async (t) => {
  const state = await setup(t);
  await assert.rejects(
    handleTextReflowRoute(context(state, { ...state.request, extra: true })),
    { code: 'PDF_TEXT_REFLOW_OPTIONS_INVALID', status: 400 },
  );
  await assert.rejects(
    handleTextReflowRoute(context(state, { ...state.request, sourceSha256: '0'.repeat(64) })),
    { code: 'SOURCE_VERSION_MISMATCH', status: 409 },
  );
});

test('text-reflow route rejects forged service results', async (t) => {
  const state = await setup(t);
  const forged = {
    kind: 'pdf-text-reflow',
    artifact: {
      id: '11111111-1111-4111-8111-111111111111', documentId: state.document.id,
      displayName: 'text-reflow.pdf', mediaType: 'application/pdf', size: 64,
      sha256: 'a'.repeat(64), operation: {}, createdAt: new Date().toISOString(),
    },
    proof: {}, limitations: ['forged'],
  };
  const value = context(state);
  value.textReflow = { reflow: async () => forged };
  await assert.rejects(handleTextReflowRoute(value), { code: 'PDF_TEXT_REFLOW_OUTPUT_INVALID', status: 502 });
});

test('text-reflow route revokes a promoted artifact when already disconnected', async (t) => {
  const state = await setup(t);
  let artifactId = null;
  const service = state.textReflow;
  const value = context(state, state.request, { destroyed: true });
  value.textReflow = { reflow: async (...args) => {
    const result = await service.reflow(...args);
    artifactId = result.artifact.id;
    return result;
  } };
  assert.equal(await handleTextReflowRoute(value), true);
  assert.equal(value.response.status, undefined);
  assert.throws(() => state.store.getArtifact(artifactId), { code: 'ARTIFACT_NOT_FOUND' });
});

test('authenticated document router exposes the source-bound text-reflow operation', async (t) => {
  const state = await setup(t);
  const handler = createAppHandler({
    staticHandler() {}, store: state.store, service: {}, workspaceState: {},
    textReflow: state.textReflow, token: 'token', host: '127.0.0.1', port: 4173,
  });
  const options = {
    method: 'POST', url: `/api/documents/${state.document.id}/text-reflow`,
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' },
    body: JSON.stringify(state.request),
  };
  assert.equal((await invoke(handler, options)).statusCode, 401);
  const response = await invoke(handler, {
    ...options, headers: { ...options.headers, 'x-platen-token': 'token' },
  });
  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body.toString('utf8'));
  assert.equal(body.result.kind, 'pdf-text-reflow');
  assert.equal(body.result.artifact.documentId, state.document.id);
  await state.store.deleteArtifact(body.result.artifact.id);
});
