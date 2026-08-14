import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import { handleFullPageRedactionBatchRoute, handleFullPageRedactionRoute } from '../scripts/host/routes/full-page-redaction-routes.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';

const sourceSha256 = 'a'.repeat(64);
const request = Object.freeze({
  profile: 'local-object-full-page-redaction-v1', sourceSha256, page: 2,
});

function context(body = request, { aborted = false, service = true } = {}) {
  const response = new EventEmitter();
  const controller = new AbortController();
  if (aborted) controller.abort();
  const calls = [];
  const deleted = [];
  return {
    request: { method: 'POST' }, response,
    url: new URL('http://local.test/api/documents/doc/full-page-redaction'),
    documentId: 'doc', operation: 'full-page-redaction',
    processing: { signal: controller.signal },
    fullPageRedaction: service ? { update: async (...args) => {
      calls.push(args);
      return { kind: 'pdf-full-page-redaction', artifact: { id: 'artifact-1' } };
    }, updateBatch: async (...args) => {
      calls.push(args);
      return { kind: 'pdf-full-page-redaction-batch', artifact: { id: 'artifact-1' } };
    } } : null,
    store: { deleteArtifact: async (id) => { deleted.push(id); } },
    bodyLimit: 1_024,
    exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object'
      && !Array.isArray(value) && Object.keys(value).length === keys.length
      && Object.keys(value).every((key) => keys.includes(key)),
    method: (value, expected) => assert.equal(value.method, expected),
    readJson: async () => body,
    json: (_response, status, value) => { response.status = status; response.value = value; },
    calls, deleted,
  };
}

test('full-page redaction route accepts one fixed authenticated source-bound request', async () => {
  const value = context();
  assert.equal(await handleFullPageRedactionRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.deepEqual(value.calls[0][0], 'doc');
  assert.deepEqual(value.calls[0][1], request);
  assert.equal(value.calls[0][2].sourceSha256, sourceSha256);
  assert(value.calls[0][2].signal instanceof AbortSignal);
  for (const invalid of [
    null,
    { ...request, sourceSha256: undefined },
    { ...request, sourceSha256: 1 },
    { ...request, extra: true },
    { ...request, sourceSha256: sourceSha256.toUpperCase() },
    { ...request, profile: 'custom' },
    { ...request, page: 0 },
    { ...request, page: 101 },
    { ...request, page: 1.5 },
  ]) {
    const invalidContext = context(invalid);
    await assert.rejects(handleFullPageRedactionRoute(invalidContext), {
      code: 'INVALID_FULL_PAGE_REDACTION_OPTIONS',
    });
    assert.deepEqual(invalidContext.calls, []);
  }

  let pageReads = 0;
  const changingPage = { ...request };
  Object.defineProperty(changingPage, 'page', {
    enumerable: true,
    get() {
      pageReads += 1;
      return pageReads === 1 ? 1 : 0;
    },
  });
  const changingPageContext = context(changingPage);
  await assert.rejects(handleFullPageRedactionRoute(changingPageContext), {
    code: 'INVALID_FULL_PAGE_REDACTION_OPTIONS',
  });
  assert.deepEqual(changingPageContext.calls, []);
  await assert.rejects(handleFullPageRedactionRoute(context(request, { service: false })), {
    code: 'FULL_PAGE_REDACTION_UNAVAILABLE',
  });
});

test('full-page redaction route revokes a promoted artifact after cancellation', async () => {
  const value = context(undefined, { aborted: true });
  assert.equal(await handleFullPageRedactionRoute(value), true);
  assert.deepEqual(value.deleted, ['artifact-1']);
  assert.equal(value.response.status, undefined);
});

test('bootstrap exposes full-page redaction readiness without changing browser identity', async () => {
  const response = {};
  await handleBootstrapRoute({
    pathname: '/api/bootstrap', request: { method: 'GET' }, response,
    service: { availability: async () => [] },
    inputs: null, conversion: null, domainFacade: null,
    aecArtifacts: null, projectBundles: null,
    accessibilityRemediations: null, standardsValidations: null,
    incrementalMetadata: null, incrementalBleedBox: null, incrementalGoToLink: null,
    incrementalNamedDestination: null, incrementalPageVector: null,
    incrementalAccessibilityMetadata: null,
    javascriptRemoval: null, attachmentRemoval: null, annotationFlatten: null,
    fullPageRedaction: {},
    pdfkitInspections: null, pdfkitOutlineSplits: null,
    pdfkitMutations: null, pdfkitProtection: null, pdfkitSanitization: null,
    redactionPlans: null, redactionPlanReports: null,
    signatureTrustReady: false, pluginSandboxProbeReady: false, token: 'token',
    method: () => {}, requireLocalFetchMetadata: () => {},
    json: (_response, _status, value) => { response.value = value; },
    sanitizedEngineAvailability: (value) => value,
  });
  assert.equal(response.value.host.fullPageRedactionReady, true);
});

test('router requires the local session token before dispatching full-page redaction', async () => {
  const response = new EventEmitter();
  response.writableEnded = false; response.destroyed = false;
  const handler = createAppHandler({
    staticHandler() {}, store: { deleteArtifact: async () => {} }, service: {}, workspaceState: {},
    fullPageRedaction: { async update() { return { artifact: { id: 'never' } }; } },
    token: 'token', host: '127.0.0.1', port: 4173,
  });
  const body = new Readable({ read() { this.push(JSON.stringify(request)); this.push(null); } });
  Object.assign(body, {
    method: 'POST', url: '/api/documents/doc/full-page-redaction',
    headers: {
      host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json', 'x-platen-token': 'wrong',
    },
  });
  response.writeHead = (_status) => { response.status = _status; };
  response.end = () => { response.writableEnded = true; };
  await handler(body, response);
  assert.equal(response.status, 401);
});

test('full-page redaction batch route accepts exact authenticated pages and forwards one atomic call', async () => {
  const batch = { profile: 'local-object-full-page-redaction-batch-v1', sourceSha256, pages: [1, 3, 5] };
  const value = context(batch);
  value.operation = 'full-page-redaction-batch';
  value.url = new URL('http://local.test/api/documents/doc/full-page-redaction-batch');
  value.fullPageRedaction.updateBatch = async (...args) => { value.calls.push(args); return { kind: 'pdf-full-page-redaction-batch', artifact: { id: 'artifact-1' } }; };
  assert.equal(await handleFullPageRedactionBatchRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.deepEqual(value.calls[0][1], batch);
  assert.equal(value.calls[0][2].sourceSha256, sourceSha256);
  assert(value.calls[0][2].signal instanceof AbortSignal);
  for (const invalid of [
    null,
    { ...batch, profile: 'custom' },
    { ...batch, sourceSha256: undefined },
    { ...batch, sourceSha256: 1 },
    { ...batch, pages: null },
    { ...batch, pages: [] },
    { ...batch, pages: Array.from({ length: 33 }, (_, index) => index + 1) },
    { ...batch, pages: [1, 1] },
    { ...batch, pages: [3, 1] },
    { ...batch, pages: [0] },
    { ...batch, pages: [101] },
    { ...batch, pages: [1.5] },
    { ...batch, extra: true },
  ]) {
    const invalidContext = Object.assign(context(invalid), {
      operation: 'full-page-redaction-batch',
      url: new URL('http://local.test/api/documents/doc/full-page-redaction-batch'),
    });
    await assert.rejects(handleFullPageRedactionBatchRoute(invalidContext), {
      code: 'INVALID_FULL_PAGE_REDACTION_BATCH_OPTIONS',
    });
    assert.deepEqual(invalidContext.calls, []);
  }


  let pagesReads = 0;
  const changingPages = { ...batch };
  Object.defineProperty(changingPages, 'pages', {
    enumerable: true,
    get() {
      pagesReads += 1;
      return pagesReads === 1 ? [1, 3] : [3, 1];
    },
  });
  const changingPagesContext = Object.assign(context(changingPages), {
    operation: 'full-page-redaction-batch',
    url: new URL('http://local.test/api/documents/doc/full-page-redaction-batch'),
  });
  await assert.rejects(handleFullPageRedactionBatchRoute(changingPagesContext), {
    code: 'INVALID_FULL_PAGE_REDACTION_BATCH_OPTIONS',
  });
  assert.deepEqual(changingPagesContext.calls, []);

  const cancelled = context(batch, { aborted: true });
  cancelled.operation = 'full-page-redaction-batch';
  cancelled.url = new URL('http://local.test/api/documents/doc/full-page-redaction-batch');
  assert.equal(await handleFullPageRedactionBatchRoute(cancelled), true);
  assert.deepEqual(cancelled.deleted, ['artifact-1']);
  assert.equal(cancelled.response.status, undefined);
});
