import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import { handleIncrementalPageVectorRoute } from '../scripts/host/routes/incremental-page-vector-routes.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';

const sourceSha256 = 'a'.repeat(64);
const request = Object.freeze({
  profile: 'local-incremental-page-vector-v1',
  sourceSha256,
  page: 2,
  rect: { x: 10, y: 20, width: 580, height: 740 },
});

function context(body = request, { aborted = false } = {}) {
  const response = new EventEmitter();
  const calls = [];
  const deleted = [];
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    request: { method: 'POST' },
    response,
    url: new URL('http://local.test/api/documents/id/incremental-page-vector'),
    documentId: 'id',
    operation: 'incremental-page-vector',
    processing: { signal: controller.signal },
    store: { deleteArtifact: async (id) => { deleted.push(id); } },
    incrementalPageVector: {
      update: async (...args) => {
        calls.push(args);
        return { artifact: { id: 'page-vector' }, kind: 'pdf-incremental-page-vector' };
      },
    },
    bodyLimit: 2_048,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && Object.keys(value).every((key) => keys.includes(key)),
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => body,
    json: (_response, status, value) => { response.status = status; response.value = value; },
    calls,
    deleted,
  };
}

test('page-vector route accepts only the fixed source-bound request', async () => {
  const value = context();
  assert.equal(await handleIncrementalPageVectorRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.deepEqual(value.calls[0][1], {
    profile: request.profile,
    page: request.page,
    rect: request.rect,
  });
  assert.equal(value.calls[0][2].sourceSha256, sourceSha256);
  assert(value.calls[0][2].signal instanceof AbortSignal);
  for (const invalid of [
    { ...request, extra: true },
    { ...request, sourceSha256: sourceSha256.toUpperCase() },
    { ...request, profile: 'custom' },
    { ...request, page: 0 },
    { ...request, rect: { ...request.rect, width: 0 } },
  ]) {
    await assert.rejects(handleIncrementalPageVectorRoute(context(invalid)), {
      code: 'INVALID_INCREMENTAL_PAGE_VECTOR_OPTIONS',
    });
  }
});

test('page-vector route revokes a promoted artifact after cancellation', async () => {
  const value = context(undefined, { aborted: true });
  assert.equal(await handleIncrementalPageVectorRoute(value), true);
  assert.deepEqual(value.deleted, ['page-vector']);
  assert.equal(value.response.status, undefined);
});

test('router revokes a page-vector artifact after disconnect', async () => {
  const deleted = []; const response = new EventEmitter();
  response.destroyed = false; response.writableEnded = false;
  const handler = createAppHandler({
    staticHandler() {},
    store: { deleteArtifact: async (id) => { deleted.push(id); } },
    service: {},
    workspaceState: {},
    incrementalPageVector: {
      async update() {
        response.destroyed = true;
        response.emit('close');
        return { artifact: { id: 'router-page-vector' }, kind: 'pdf-incremental-page-vector' };
      },
    },
    token: 'token', host: '127.0.0.1', port: 4173,
  });
  const requestBody = new Readable({
    read() {
      this.push(JSON.stringify(request));
      this.push(null);
    },
  });
  Object.assign(requestBody, {
    method: 'POST', url: '/api/documents/id/incremental-page-vector',
    headers: {
      host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json', 'x-platen-token': 'token',
    },
  });
  await handler(requestBody, response);
  assert.deepEqual(deleted, ['router-page-vector']);
});

test('bootstrap exposes page-vector readiness without a browser contract', async () => {
  const response = {};
  await handleBootstrapRoute({
    pathname: '/api/bootstrap', request: { method: 'GET' }, response,
    service: { availability: async () => [] },
    inputs: null, conversion: null, domainFacade: null,
    aecArtifacts: null, projectBundles: null,
    accessibilityRemediations: null, standardsValidations: null,
    incrementalMetadata: null, incrementalBleedBox: null, incrementalGoToLink: null,
    incrementalNamedDestination: null, incrementalPageVector: {},
    incrementalAccessibilityMetadata: null,
    javascriptRemoval: null, attachmentRemoval: null, annotationFlatten: null,
    pdfkitInspections: null, pdfkitOutlineSplits: null,
    pdfkitMutations: null, pdfkitProtection: null, pdfkitSanitization: null,
    redactionPlans: null, redactionPlanReports: null,
    signatureTrustReady: false, pluginSandboxProbeReady: false, token: 'token',
    method: () => {}, requireLocalFetchMetadata: () => {},
    json: (_response, _status, value) => { response.value = value; },
    sanitizedEngineAvailability: (value) => value,
  });
  assert.equal(response.value.host.incrementalPageVectorReady, true);
});
