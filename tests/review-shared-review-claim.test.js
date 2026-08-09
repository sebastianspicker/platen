import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DocumentStore } from '../scripts/host/document-store.mjs';
import { PdfReviewSharedExchangeService } from '../scripts/host/pdf-review-shared-exchange-service.mjs';
import { handleReviewSharedExchangeRoute } from '../scripts/host/routes/review-shared-exchange-routes.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import {
  REVIEW_SHARED_EXCHANGE_PROFILE,
  createReviewSharedExchangeEndpoints,
} from '../src/core/local-host-review-shared-exchange-endpoints.js';

const annotation = {
  id: 'annotation-1', prototypeSidecar: true, type: 'highlight', page: 1,
  rectangle: { x: 1, y: 2, width: 30, height: 10 }, text: 'Review this', author: 'reviewer-local',
  status: 'open', customStatus: null, properties: {}, mentions: [],
  createdAt: '2026-08-03T10:00:00.000Z', replies: [],
};

async function setup(t, withAnnotation = false) {
  const store = await new DocumentStore({ root: await mkdtemp('/tmp/review-shared-route-') }).initialize();
  const source = await store.createDocument({ stream: Readable.from([Buffer.from('%PDF-1.7\nsource')]), displayName: 'source.pdf' });
  const workspace = new WorkspaceStateStore(store);
  if (withAnnotation) workspace.createEntity(source.id, 'annotations', annotation);
  const service = new PdfReviewSharedExchangeService({ documents: store, workspace });
  t.after(() => store.dispose());
  return { store, source, workspace, service };
}

function exactJsonObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function route(state, body, { service = state.service, signal = new AbortController().signal, destroyed = false } = {}) {
  const response = Object.assign(new EventEmitter(), { destroyed });
  const context = {
    request: { method: 'POST' }, response,
    url: new URL(`http://local/api/documents/${state.source.id}/review-shared-exchange`),
    documentId: state.source.id, operation: 'review-shared-exchange', processing: { signal },
    store: state.store, reviewSharedExchange: service, bodyLimit: 1_048_576,
    exactJsonObject, method: (value, expected) => assert.equal(value.method, expected),
    readJson: async () => body,
    json: (_response, status, value) => { response.status = status; response.value = value; },
  };
  return { context, response };
}

test('shared-review claim exports and imports the real source-bound service through frozen client results', async (t) => {
  const source = await setup(t, true);
  const target = await setup(t);
  const transport = async (state, _path, options) => {
    const body = JSON.parse(options.body);
    const request = route(state, body);
    await handleReviewSharedExchangeRoute(request.context);
    return request.response.value;
  };
  const sourceClient = createReviewSharedExchangeEndpoints({
    json: (path, options) => transport(source, path, options),
  });
  const exported = await sourceClient.exportReviewSharedExchange(source.source.id, {
    sourceSha256: source.source.sha256, baseRevision: 0, reviewerId: 'reviewer-local',
  });
  assert.equal(exported.kind, REVIEW_SHARED_EXCHANGE_PROFILE);
  assert(Object.isFrozen(exported));
  assert(Object.isFrozen(exported.manifest));
  assert.equal(exported.mediaType, 'application/vnd.platen.review-exchange+zip');

  const targetClient = createReviewSharedExchangeEndpoints({
    json: (path, options) => transport(target, path, options),
  });
  const imported = await targetClient.importReviewSharedExchange(target.source.id, {
    sourceSha256: target.source.sha256, archiveBase64: exported.archiveBase64,
  });
  assert.equal(imported.applied, 1);
  assert.equal(imported.idempotent, false);
  assert(Object.isFrozen(imported));
  assert.equal(target.workspace.snapshot(target.source.id).namespaces.annotations[0].id, 'annotation-1');
});

test('shared-review route rejects forged output and honors disconnect cancellation', async (t) => {
  const state = await setup(t, true);
  const exported = await state.service.export(state.source.id, { reviewerId: 'reviewer-local', baseRevision: 0 });
  const forgedService = { export: async () => ({ ...exported, sha256: 'b'.repeat(64) }), import: state.service.import.bind(state.service) };
  await assert.rejects(handleReviewSharedExchangeRoute(route(state, {
    action: 'export', sourceSha256: state.source.sha256, baseRevision: 0, reviewerId: 'reviewer-local',
  }, { service: forgedService }).context), { code: 'REVIEW_SHARED_EXCHANGE_RESULT_INVALID', status: 502 });

  const controller = new AbortController(); controller.abort();
  await assert.rejects(handleReviewSharedExchangeRoute(route(state, {
    action: 'import', sourceSha256: state.source.sha256, archiveBase64: exported.bytes.toString('base64'),
  }, { signal: controller.signal }).context), { code: 'JOB_CANCELLED', status: 499 });
  const disconnected = route(state, {
    action: 'export', sourceSha256: state.source.sha256, baseRevision: 0, reviewerId: 'reviewer-local',
  }, { destroyed: true });
  assert.equal(await handleReviewSharedExchangeRoute(disconnected.context), true);
  assert.equal(disconnected.response.status, undefined);
});

test('shared-review client validates exact requests and forged responses', async () => {
  const endpoint = createReviewSharedExchangeEndpoints({ json: async () => ({ result: { kind: REVIEW_SHARED_EXCHANGE_PROFILE } }) });
  assert.throws(() => endpoint.exportReviewSharedExchange('document', { sourceSha256: 'a'.repeat(64), baseRevision: 0, reviewerId: 'person' }), TypeError);
  await assert.rejects(Promise.resolve().then(() => endpoint.importReviewSharedExchange('document', {
    sourceSha256: 'a'.repeat(64), archiveBase64: Buffer.from('not-a-zip').toString('base64'),
  })), TypeError);
});
