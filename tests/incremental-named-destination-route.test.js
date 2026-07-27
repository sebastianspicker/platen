import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleBootstrapRoute } from '../scripts/host/routes/bootstrap-routes.mjs';
import { handleIncrementalNamedDestinationRoute } from '../scripts/host/routes/incremental-named-destination-routes.mjs';
import { createAppHandler } from '../scripts/host/router.mjs';
import {
  assertIncrementalNamedDestinationProof,
  assertOutputNamedDestinationInventory,
  assertSourceNamedDestinationInventory,
} from '../scripts/host/pdf-incremental-named-destination-validation.mjs';
import { PdfIncrementalNamedDestinationService } from '../scripts/host/pdf-incremental-named-destination-service.mjs';
import { promoteIncrementalNamedDestinationArtifact } from '../scripts/host/pdf-incremental-named-destination-artifact.mjs';

const sourceSha256 = 'a'.repeat(64);
const body = Object.freeze({ profile: 'local-incremental-named-destination-v1', sourceSha256, targetPage: 1, name: 'chapter-1' });

function context(value = body, { aborted = false } = {}) {
  const response = new EventEmitter();
  const calls = [];
  const deleted = [];
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    request: { method: 'POST' }, response,
    url: new URL('http://local.test/api/documents/id/incremental-named-destination'), documentId: 'id', operation: 'incremental-named-destination',
    processing: { signal: controller.signal }, store: { deleteArtifact: async (id) => { deleted.push(id); } },
    incrementalNamedDestination: { update: async (...args) => { calls.push(args); return { artifact: { id: 'named-destination' }, kind: 'pdf-incremental-named-destination' }; } },
    bodyLimit: 2_048,
    exactJsonObject: (item, keys) => Boolean(item) && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === keys.length && Object.keys(item).every((key) => keys.includes(key)),
    method: (request, expected) => assert.equal(request.method, expected), readJson: async () => value,
    json: (_response, status, result) => { response.status = status; response.value = result; }, calls, deleted,
  };
}

test('named-destination route accepts only the fixed source-bound request', async () => {
  const value = context();
  assert.equal(await handleIncrementalNamedDestinationRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.deepEqual(value.calls[0][1], { profile: body.profile, targetPage: 1, name: 'chapter-1' });
  assert.equal(value.calls[0][2].sourceSha256, sourceSha256);
  assert(value.calls[0][2].signal instanceof AbortSignal);
  for (const invalid of [
    { ...body, extra: true }, { ...body, sourceSha256: sourceSha256.toUpperCase() },
    { ...body, name: 'not allowed' }, { ...body, name: '!unsafe' },
  ]) await assert.rejects(handleIncrementalNamedDestinationRoute(context(invalid)), { code: 'INVALID_INCREMENTAL_NAMED_DESTINATION_OPTIONS' });
});

test('named-destination route revokes a promoted artifact after cancellation', async () => {
  const value = context(undefined, { aborted: true });
  assert.equal(await handleIncrementalNamedDestinationRoute(value), true);
  assert.deepEqual(value.deleted, ['named-destination']);
  assert.equal(value.response.status, undefined);
});

test('router revokes a named-destination artifact on disconnect after promotion', async () => {
  const deleted = [];
  const response = new EventEmitter();
  response.destroyed = false; response.writableEnded = false;
  const handler = createAppHandler({
    staticHandler() {}, store: { deleteArtifact: async (id) => { deleted.push(id); } }, service: {}, workspaceState: {},
    incrementalNamedDestination: { async update() { response.destroyed = true; response.emit('close'); return { artifact: { id: 'router-named-destination' }, kind: 'pdf-incremental-named-destination' }; } },
    token: 'token', host: '127.0.0.1', port: 4173,
  });
  const request = Readable.from([JSON.stringify(body)]);
  Object.assign(request, { method: 'POST', url: '/api/documents/id/incremental-named-destination', headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-platen-token': 'token' } });
  await handler(request, response);
  assert.deepEqual(deleted, ['router-named-destination']);
});

test('named-destination evidence rejects non-empty, truncated, and malformed-output inventories', () => {
  assert.throws(() => assertSourceNamedDestinationInventory({ items: [{ page: 1, destination: '[ Fit ]', name: 'old' }], truncated: false }), { code: 'INCREMENTAL_NAMED_DESTINATION_SOURCE_UNSUPPORTED' });
  assert.throws(() => assertSourceNamedDestinationInventory({ items: [], truncated: true }), { code: 'INCREMENTAL_NAMED_DESTINATION_SOURCE_UNSUPPORTED' });
  for (const inventory of [
    { items: [], truncated: false },
    { items: [{ page: 1, destination: '[ XYZ 0 0 0 ]', name: body.name }], truncated: false },
    { items: [{ page: 2, destination: '[ Fit                     ]', name: body.name }], truncated: false },
    { items: [{ page: 1, destination: '[ Fit ]', name: body.name }], truncated: true },
  ]) assert.throws(() => assertOutputNamedDestinationInventory(inventory, body), { code: 'INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID' });
  assert.doesNotThrow(() => assertOutputNamedDestinationInventory({ items: [{ page: 1, destination: '[ Fit                     ]', name: body.name }], truncated: false }, body));
});

test('named-destination proof binds the transient request name by digest', () => {
  const proof = {
    profile: body.profile, sourceBytes: 1_000, outputBytes: 1_200,
    sourcePrefixPreserved: true, revisionCount: 2,
    previousXrefOffset: 900, appendedXrefOffset: 1_100,
    targetPage: 1, targetPageObjectNumber: 3, targetPageGeneration: 0,
    nameSha256: '0'.repeat(64), effectiveSize: 5,
    rootPreserved: true, infoPreserved: true, idPolicy: 'absent',
  };
  assert.throws(
    () => assertIncrementalNamedDestinationProof(proof, 1_000, 1_200, body),
    { code: 'INCREMENTAL_NAMED_DESTINATION_OUTPUT_INVALID' },
  );
});

test('named-destination service rejects a core-normalized name outside the public grammar', async () => {
  const store = Object.fromEntries(['getDocument', 'getSourcePath', 'verifySource', 'createJobWorkspace', 'cleanupJob', 'promotePdfArtifact', 'deleteArtifact'].map((name) => [name, async () => {}]));
  const service = new PdfIncrementalNamedDestinationService({
    store, poppler: { execute: async () => ({}) },
    core: {
      normalizeIncrementalNamedDestination: () => ({ profile: body.profile, targetPage: 1, name: '!unsafe' }),
      writeIncrementalPdfNamedDestination() {}, inspectIncrementalPdfNamedDestination() {},
    },
  });
  await assert.rejects(service.update('id', body, { sourceSha256 }), { code: 'INVALID_INCREMENTAL_NAMED_DESTINATION_OPTIONS' });
});

test('named-destination artifact retains only a name digest in its public result and provenance', async () => {
  let options;
  const result = await promoteIncrementalNamedDestinationArtifact({
    store: { promotePdfArtifact: async (_id, _path, value) => { options = value; return { id: 'artifact', sha256: 'b'.repeat(64) }; } },
    documentId: '11111111-1111-4111-8111-111111111111', source: { id: '11111111-1111-4111-8111-111111111111', sha256: sourceSha256, displayName: 'source.pdf' }, outputPath: '/private/output.pdf', outputDigest: 'b'.repeat(64), pageCount: 1, request: { profile: body.profile, targetPage: 1, name: body.name }, signal: new AbortController().signal,
  });
  assert.equal(JSON.stringify(result).includes(body.name), false);
  assert.equal(JSON.stringify(options.operation).includes(body.name), false);
  assert.deepEqual(Object.keys(result.destination).sort(), ['fit', 'nameSha256', 'profile', 'targetPage']);
});

test('bootstrap exposes named-destination readiness without a browser contract', async () => {
  const response = {};
  await handleBootstrapRoute({ pathname: '/api/bootstrap', request: { method: 'GET' }, response, service: { availability: async () => [] }, inputs: null, conversion: null, domainFacade: null, aecArtifacts: null, projectBundles: null, accessibilityRemediations: null, standardsValidations: null, incrementalMetadata: null, incrementalBleedBox: null, incrementalGoToLink: null, incrementalNamedDestination: {}, javascriptRemoval: null, pdfkitInspections: null, pdfkitOutlineSplits: null, pdfkitMutations: null, pdfkitProtection: null, pdfkitSanitization: null, redactionPlans: null, signatureTrustReady: false, pluginSandboxProbeReady: false, token: 'token', method: () => {}, requireLocalFetchMetadata: () => {}, json: (_response, _status, value) => { response.value = value; }, sanitizedEngineAvailability: (value) => value });
  assert.equal(response.value.host.incrementalNamedDestinationReady, true);
});
