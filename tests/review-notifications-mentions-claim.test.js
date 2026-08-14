import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { PdfReviewNotificationsService } from '../scripts/host/pdf-review-notifications-service.mjs';
import { handleReviewNotificationRoute } from '../scripts/host/routes/review-notification-routes.mjs';
import { WorkspaceStateStore } from '../scripts/host/workspace-state.mjs';
import {
  createReviewNotificationEndpoints,
  validateReviewNotificationResult,
} from '../src/core/local-host-review-notification-endpoints.js';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE = 'a'.repeat(64);

function annotation() {
  return {
    id: 'annotation-1', type: 'comment', page: 1,
    rectangle: [1, 2, 3, 4], text: 'private review text', author: 'reviewer-author',
    status: 'open', customStatus: null, properties: {}, mentions: ['reviewer-target'],
    createdAt: '2026-08-03T10:00:00.000Z', replies: [{
      id: 'comment-1', text: 'private reply text', author: 'reviewer-author', at: '2026-08-03T10:01:00.000Z', mentions: ['reviewer-target'],
    }],
  };
}

function setup() {
  const documents = {
    getDocument: (id) => ({ id, sha256: SOURCE }),
    verifySource: async () => true,
  };
  const workspace = new WorkspaceStateStore((id) => id === DOCUMENT_ID);
  workspace.createEntity(DOCUMENT_ID, 'annotations', annotation());
  const service = new PdfReviewNotificationsService({ documents, workspace });
  return { documents, workspace, service };
}

function routeContext({ state, operation, body, service = state.service, signal = new AbortController().signal }) {
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
  let payload;
  return {
    context: {
      request: { method: 'POST' }, response,
      url: new URL(`http://local.test/api/documents/${DOCUMENT_ID}/${operation}`),
      documentId: DOCUMENT_ID, operation, processing: { signal }, store: state.documents,
      reviewNotifications: service, bodyLimit: 2_048,
      exactJsonObject: (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length
        && Object.keys(value).every((key) => keys.includes(key)),
      method: (request, expected) => assert.equal(request.method, expected),
      readJson: async () => body,
      json: (_response, status, value) => { assert.equal(status, 200); payload = value; },
    },
    response,
    get responseBody() { return payload; },
  };
}

test('review mention notifications use the real source-bound service through both authenticated operations', async () => {
  const state = setup();
  const endpoint = createReviewNotificationEndpoints({
    json: async (path, options) => {
      const operation = path.endsWith('/review-notification-read') ? 'review-notification-read' : 'review-notifications';
      const route = routeContext({ state, operation, body: JSON.parse(options.body), signal: options.signal });
      await handleReviewNotificationRoute(route.context);
      return route.responseBody;
    },
  });

  const generated = await endpoint.generateReviewNotifications(DOCUMENT_ID, {
    sourceSha256: SOURCE, expectedRevision: 1, actorId: 'reviewer-actor',
  });
  assert.equal(generated.applied, 2);
  assert.equal(generated.sourceSha256, SOURCE);
  assert.equal(Object.isFrozen(generated), true);
  assert.equal(state.workspace.snapshot(DOCUMENT_ID).namespaces.reviewRecords.every((record) => !Object.hasOwn(record, 'text')), true);

  const notificationId = state.workspace.snapshot(DOCUMENT_ID).namespaces.reviewRecords[0].id;
  const marked = await endpoint.markReviewNotificationRead(DOCUMENT_ID, {
    sourceSha256: SOURCE, expectedRevision: generated.revision, notificationId,
  });
  assert.equal(marked.changed, true);
  assert.equal(marked.sourceSha256, SOURCE);
  assert.equal(state.workspace.snapshot(DOCUMENT_ID).namespaces.reviewRecords.find((record) => record.id === notificationId).status, 'read');
});

test('review notification route forwards cancellation, rejects stale revisions, and rejects forged service results', async () => {
  const state = setup();
  const generatedRoute = routeContext({ state, operation: 'review-notifications', body: { sourceSha256: SOURCE, expectedRevision: 1 } });
  await handleReviewNotificationRoute(generatedRoute.context);
  const generated = generatedRoute.responseBody.result;
  const record = state.workspace.snapshot(DOCUMENT_ID).namespaces.reviewRecords[0];

  await assert.rejects(
    handleReviewNotificationRoute(routeContext({
      state,
      operation: 'review-notification-read',
      body: { sourceSha256: SOURCE, expectedRevision: generated.revision - 1, notificationId: record.id },
    }).context),
    { code: 'REVISION_CONFLICT', status: 409 },
  );

  const forged = { ...generated, sourceSha256: 'b'.repeat(64) };
  await assert.rejects(
    handleReviewNotificationRoute(routeContext({
      state,
      operation: 'review-notifications',
      body: { sourceSha256: SOURCE, expectedRevision: generated.revision },
      service: { generate: async () => forged },
    }).context),
    { code: 'REVIEW_NOTIFICATION_RESULT_INVALID', status: 502 },
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    handleReviewNotificationRoute(routeContext({
      state,
      operation: 'review-notifications',
      body: { sourceSha256: SOURCE, expectedRevision: generated.revision },
      signal: controller.signal,
    }).context),
    { code: 'JOB_CANCELLED', status: 499 },
  );
});

test('review notification client rejects malformed requests and forged privacy-unsafe results', async () => {
  const state = setup();
  const route = routeContext({ state, operation: 'review-notifications', body: { sourceSha256: SOURCE, expectedRevision: 1 } });
  await handleReviewNotificationRoute(route.context);
  const valid = route.responseBody.result;

  const endpoint = createReviewNotificationEndpoints({ json: async () => ({ result: { ...valid, annotationText: 'private' } }) });
  await assert.rejects(endpoint.generateReviewNotifications(DOCUMENT_ID, { sourceSha256: SOURCE, expectedRevision: 1 }), TypeError);
  assert.throws(() => endpoint.generateReviewNotifications(DOCUMENT_ID, { sourceSha256: SOURCE, expectedRevision: 1 }, { signal: {} }), TypeError);
  assert.throws(() => endpoint.markReviewNotificationRead(DOCUMENT_ID, {
    sourceSha256: SOURCE, expectedRevision: valid.revision, notificationId: 'forged id',
  }), TypeError);
  assert.throws(() => validateReviewNotificationResult({ ...valid, applied: 501 }, {
    sourceSha256: SOURCE, expectedRevision: 1,
  }), TypeError);
});
