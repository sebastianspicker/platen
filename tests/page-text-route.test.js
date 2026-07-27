import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import { handlePageTextRoute } from '../scripts/host/routes/page-text-routes.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import { invoke } from './support/host-router-fixture-base.js';

const sourceSha256 = 'a'.repeat(64);
const request = Object.freeze({
  profile: 'local-page-text-run-v1', sourceSha256,
  page: 2, x: 36, y: 72, size: 12, text: 'Hello (PDF)',
});

function context(body = request) {
  const response = new EventEmitter(); const calls = [];
  return {
    request: { method: 'POST' }, response,
    url: new URL('http://local.test/api/documents/id/page-text'),
    documentId: 'id', operation: 'page-text',
    processing: { signal: new AbortController().signal },
    store: { deleteArtifact: async () => {} },
    pageText: { insert: async (...args) => {
      calls.push(args); return { artifact: { id: 'page-text' }, kind: 'pdf-page-text-run' };
    } },
    bodyLimit: 2_048,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object'
      && !Array.isArray(value) && Object.keys(value).length === keys.length
      && Object.keys(value).every((key) => keys.includes(key)),
    method: (value, expected) => assert.equal(value.method, expected),
    readJson: async () => body,
    json: (_response, status, value) => { response.status = status; response.value = value; },
    calls,
  };
}

test('page-text route accepts only the fixed source-bound request', async () => {
  const value = context();
  assert.equal(await handlePageTextRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.equal(value.calls[0][0], 'id');
  assert.deepEqual({ ...value.calls[0][1], signal: undefined }, {
    profile: request.profile, page: 2, x: 36, y: 72, size: 12,
    text: 'Hello (PDF)', sourceSha256, signal: undefined,
  });
  assert(value.calls[0][1].signal instanceof AbortSignal);
  for (const invalid of [
    { ...request, extra: true }, { ...request, sourceSha256: sourceSha256.toUpperCase() },
    { ...request, profile: 'custom' }, { ...request, size: 12.5 },
    { ...request, text: 'not\nprintable' }, { ...request, text: ' padded ' },
  ]) await assert.rejects(handlePageTextRoute(context(invalid)), { code: 'INVALID_PAGE_TEXT_OPTIONS' });
});

test('bootstrap exposes optional page-text readiness', async () => {
  const response = {};
  await handleBootstrapRoute({
    pathname: '/api/bootstrap', request: { method: 'GET' }, response,
    service: { availability: async () => [] }, pageText: {}, token: 'token',
    method: () => {}, requireLocalFetchMetadata: () => {},
    json: (_response, _status, value) => { response.value = value; },
    sanitizedEngineAvailability: (value) => value,
  });
  assert.equal(response.value.host.pageTextReady, true);
});

test('router requires the local session token before page-text execution', async () => {
  const calls = [];
  const handler = createAppHandler({
    staticHandler() {}, store: { deleteArtifact: async () => {} }, service: {}, workspaceState: {},
    pageText: { async insert(...args) {
      calls.push(args); return { artifact: { id: 'page-text' }, kind: 'pdf-page-text-run' };
    } },
    token: 'token', host: '127.0.0.1', port: 4173,
  });
  const options = {
    method: 'POST', url: '/api/documents/id/page-text',
    headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  };
  const unauthorized = await invoke(handler, options);
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(calls.length, 0);
  const authorized = await invoke(handler, {
    ...options, headers: { ...options.headers, 'x-platen-token': 'token' },
  });
  assert.equal(authorized.statusCode, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].sourceSha256, sourceSha256);
});
