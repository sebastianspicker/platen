import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REVIEW_SIDECAR_INSPECTION_KIND,
  REVIEW_SIDECAR_STATUS_KIND,
  createReviewSidecarEndpoints,
} from '../src/core/local-host-review-sidecar-endpoints.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const sourceSha256 = 'a'.repeat(64);
const statusRequest = {
  sourceSha256, expectedRevision: 2, annotationId: 'annotation-1', status: 'custom', customStatus: 'needs legal',
};
const inspectionRequest = {
  sourceSha256, expectedRevision: 2,
  query: { search: '', status: null, type: null, groupBy: 'none', sortBy: 'createdAt', direction: 'asc' },
};

function transport(result, calls = []) {
  return createReviewSidecarEndpoints({
    json: async (path, options) => {
      calls.push({ path, options, body: JSON.parse(options.body) });
      return { result };
    },
  });
}

test('review sidecar client posts source-bound status and inspection requests', async () => {
  const calls = [];
  const endpoint = transport({
    kind: REVIEW_SIDECAR_STATUS_KIND, sourceDigest: sourceSha256, revision: 3,
    annotationId: 'annotation-1', status: 'custom', customStatus: 'needs legal', localOnly: true,
  }, calls);
  const status = await endpoint.setReviewSidecarStatus(documentId, statusRequest);
  assert.equal(status.kind, REVIEW_SIDECAR_STATUS_KIND);
  assert.equal(calls[0].path, `/api/documents/${documentId}/review-sidecar-status`);
  assert.deepEqual(calls[0].body, statusRequest);
  assert(Object.isFrozen(status));

  const inspect = transport({
    kind: REVIEW_SIDECAR_INSPECTION_KIND, sourceDigest: sourceSha256, revision: 2,
    annotationsOrGroups: [], count: 0, commentSummary: [], activity: [],
    limitations: ['Local session sidecar only; no PDF annotations are read or written.'], localOnly: true,
  }, calls);
  const result = await inspect.inspectReviewSidecar(documentId, inspectionRequest);
  assert.equal(result.kind, REVIEW_SIDECAR_INSPECTION_KIND);
  assert.equal(calls[1].path, `/api/documents/${documentId}/review-sidecar-inspect`);
  assert.deepEqual(calls[1].body, inspectionRequest);
});

test('review sidecar client rejects malformed requests, accessors, and forged results', async () => {
  const endpoint = transport({
    kind: REVIEW_SIDECAR_STATUS_KIND, sourceDigest: sourceSha256, revision: 3,
    annotationId: 'annotation-1', status: 'open', customStatus: null, localOnly: true,
  });
  assert.throws(() => endpoint.setReviewSidecarStatus(documentId, { ...statusRequest, customStatus: null }), TypeError);
  assert.throws(() => endpoint.setReviewSidecarStatus(documentId, { ...statusRequest, status: 'open' }), TypeError);
  assert.throws(() => endpoint.inspectReviewSidecar(documentId, {
    ...inspectionRequest, query: { ...inspectionRequest.query, search: 'x'.repeat(257) },
  }), TypeError);
  assert.throws(() => endpoint.inspectReviewSidecar(documentId, inspectionRequest, { signal: {} }), TypeError);
  const accessor = {};
  Object.defineProperty(accessor, 'sourceSha256', { enumerable: true, get: () => sourceSha256 });
  assert.throws(() => endpoint.inspectReviewSidecar(documentId, accessor), TypeError);
  const forged = transport({
    kind: REVIEW_SIDECAR_STATUS_KIND, sourceDigest: 'b'.repeat(64), revision: 3,
    annotationId: 'annotation-1', status: 'custom', customStatus: 'needs legal', localOnly: true,
  });
  await assert.rejects(forged.setReviewSidecarStatus(documentId, statusRequest), TypeError);
});
