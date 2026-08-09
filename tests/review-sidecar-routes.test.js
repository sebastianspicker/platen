import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleReviewSidecarRoute } from '../scripts/host/routes/review-sidecar-routes.mjs';

const DOCUMENT_ID = 'document-1';
const SOURCE = 'a'.repeat(64);

function context({ operation, body, service, signal = new AbortController().signal } = {}) {
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
  let payload;
  const value = {
    operation, request: { method: 'POST' }, response,
    url: new URL(`http://local.test/api/documents/${DOCUMENT_ID}/${operation}`),
    documentId: DOCUMENT_ID, processing: { signal }, reviewSidecar: service, bodyLimit: 32_768,
    method: (request, expected) => assert.equal(request.method, expected),
    readJson: async () => body,
    json: (_response, status, result) => { payload = { status, result }; },
  };
  return { value, response, get payload() { return payload; } };
}

function statusResult(body) {
  return {
    kind: 'review-sidecar-status-v1', sourceDigest: body.sourceSha256, revision: body.expectedRevision + 1,
    annotationId: body.annotationId, status: body.status, customStatus: body.customStatus, localOnly: true,
  };
}

function inspectionResult(body) {
  return {
    kind: 'review-sidecar-inspection-v1', sourceDigest: body.sourceSha256, revision: body.expectedRevision,
    annotationsOrGroups: [], count: 0, commentSummary: [], activity: [],
    limitations: ['Local session sidecar only; no PDF annotations are read or written.'], localOnly: true,
  };
}

test('review sidecar routes forward exact bounded requests and cancellation signals', async () => {
  const statusBody = { sourceSha256: SOURCE, expectedRevision: 2, annotationId: 'annotation-1', status: 'custom', customStatus: 'needs-review' };
  const inspectBody = { sourceSha256: SOURCE, expectedRevision: 2, query: { search: '', status: null, type: null, groupBy: 'none', sortBy: 'createdAt', direction: 'asc' } };
  const calls = [];
  const service = {
    async setStatus(...args) { calls.push(args); return statusResult(statusBody); },
    async inspect(...args) { calls.push(args); return inspectionResult(inspectBody); },
  };
  const status = context({ operation: 'review-sidecar-status', body: statusBody, service });
  await handleReviewSidecarRoute(status.value);
  assert.equal(status.payload.status, 200);
  assert.deepEqual(calls[0][0], DOCUMENT_ID);
  assert.equal(calls[0][1], statusBody);
  assert(calls[0][2].signal instanceof AbortSignal);
  const inspect = context({ operation: 'review-sidecar-inspect', body: inspectBody, service });
  await handleReviewSidecarRoute(inspect.value);
  assert.equal(inspect.payload.status, 200);
  assert.equal(calls[1][1], inspectBody);
});

test('review sidecar routes reject malformed requests, forged results, and missing services', async () => {
  const body = { sourceSha256: SOURCE, expectedRevision: 0, annotationId: 'annotation-1', status: 'open', customStatus: null };
  await assert.rejects(handleReviewSidecarRoute(context({ operation: 'review-sidecar-status', body: { ...body, extra: true }, service: { setStatus: async () => statusResult(body) } }).value), { code: 'INVALID_REVIEW_SIDECAR_REQUEST', status: 400 });
  await assert.rejects(handleReviewSidecarRoute(context({ operation: 'review-sidecar-status', body, service: null }).value), { code: 'REVIEW_SIDECAR_UNAVAILABLE', status: 503 });
  await assert.rejects(handleReviewSidecarRoute(context({ operation: 'review-sidecar-status', body, service: { setStatus: async () => ({ ...statusResult(body), kind: 'forged' }) } }).value), { code: 'REVIEW_SIDECAR_RESULT_INVALID', status: 502 });
});

test('review sidecar route suppresses a response after disconnect cancellation', async () => {
  const body = { sourceSha256: SOURCE, expectedRevision: 0, annotationId: 'annotation-1', status: 'open', customStatus: null };
  const controller = new AbortController();
  const route = context({ operation: 'review-sidecar-status', body, signal: controller.signal, service: {
    async setStatus() { controller.abort(); return statusResult(body); },
  } });
  await handleReviewSidecarRoute(route.value);
  assert.equal(route.payload, undefined);
});
