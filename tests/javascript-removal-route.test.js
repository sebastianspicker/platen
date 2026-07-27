import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import { handleJavaScriptRemovalRoute } from '../scripts/host/routes/javascript-removal-routes.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';

const sourceSha256 = 'a'.repeat(64);
const requestBody = Object.freeze({
  profile: 'local-document-javascript-removal-v1',
  sourceSha256,
});

function context(body = requestBody, { aborted = false } = {}) {
  const response = new EventEmitter();
  const calls = [];
  const deleted = [];
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    request: { method: 'POST' }, response,
    url: new URL('http://local.test/api/documents/id/javascript-removal'),
    documentId: 'id', operation: 'javascript-removal',
    processing: { signal: controller.signal },
    store: { deleteArtifact: async (id) => { deleted.push(id); } },
    javascriptRemoval: {
      remove: async (...args) => {
        calls.push(args);
        return { artifact: { id: 'javascript-removed' }, kind: 'pdf-javascript-removal' };
      },
    },
    bodyLimit: 2_048,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)),
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => body,
    json: (_response, status, value) => { response.status = status; response.value = value; },
    calls, deleted,
  };
}

test('JavaScript-removal route accepts only its exact fixed source-bound request', async () => {
  const value = context();
  assert.equal(await handleJavaScriptRemovalRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.equal(value.response.value.result.artifact.id, 'javascript-removed');
  assert.deepEqual(value.calls[0][0], 'id');
  assert.deepEqual(value.calls[0][1], { profile: requestBody.profile });
  assert.equal(value.calls[0][2].sourceSha256, sourceSha256);
  assert(value.calls[0][2].signal instanceof AbortSignal);

  for (const body of [
    { ...requestBody, extra: true },
    { ...requestBody, profile: 'custom' },
    { ...requestBody, sourceSha256: sourceSha256.toUpperCase() },
  ]) {
    await assert.rejects(handleJavaScriptRemovalRoute(context(body)), {
      code: 'INVALID_JAVASCRIPT_REMOVAL_OPTIONS',
    });
  }
  const queried = context();
  queried.url.search = '?unsafe=true';
  await assert.rejects(handleJavaScriptRemovalRoute(queried), { code: 'INVALID_PARAMETER' });
});

test('JavaScript-removal route revokes a promoted artifact when delivery is already cancelled', async () => {
  const value = context(undefined, { aborted: true });
  assert.equal(await handleJavaScriptRemovalRoute(value), true);
  assert.deepEqual(value.deleted, ['javascript-removed']);
  assert.equal(value.response.status, undefined);
});

test('router revokes a JavaScript-removal artifact when the client disconnects after promotion', async () => {
  const deleted = [];
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  const handler = createAppHandler({
    staticHandler() {},
    store: { deleteArtifact: async (id) => { deleted.push(id); } },
    service: {}, workspaceState: {},
    javascriptRemoval: {
      async remove() {
        response.destroyed = true;
        response.emit('close');
        return { artifact: { id: 'router-javascript-removed' }, kind: 'pdf-javascript-removal' };
      },
    },
    token: 'token', host: '127.0.0.1', port: 4173,
  });
  const request = Readable.from([JSON.stringify(requestBody)]);
  Object.assign(request, {
    method: 'POST', url: '/api/documents/id/javascript-removal',
    headers: {
      host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json', 'x-platen-token': 'token',
    },
  });
  await handler(request, response);
  assert.deepEqual(deleted, ['router-javascript-removed']);
});

test('bootstrap exposes JavaScript-removal readiness without a browser contract', async () => {
  const response = {};
  await handleBootstrapRoute({
    pathname: '/api/bootstrap', request: { method: 'GET' }, response,
    service: { availability: async () => [] }, inputs: null, conversion: null,
    domainFacade: null, aecArtifacts: null, projectBundles: null,
    accessibilityRemediations: null, standardsValidations: null,
    incrementalMetadata: null, incrementalBleedBox: null, incrementalGoToLink: null,
    javascriptRemoval: {}, pdfkitInspections: null, pdfkitOutlineSplits: null,
    pdfkitMutations: null, pdfkitProtection: null, pdfkitSanitization: null,
    redactionPlans: null, signatureTrustReady: false, pluginSandboxProbeReady: false,
    token: 'token', method: () => {}, requireLocalFetchMetadata: () => {},
    json: (_response, _status, value) => { response.value = value; },
    sanitizedEngineAvailability: (value) => value,
  });
  assert.equal(response.value.host.javascriptRemovalReady, true);
});
