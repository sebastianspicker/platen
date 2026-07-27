import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createReviewSharedExchangeManifest,
  normalizeReviewSharedExchangeRequest,
  parseReviewSharedExchangeDeltas,
  parseReviewSharedExchangeManifest,
  reviewSharedExchangeDigest,
} from '../scripts/host/pdf-review-shared-exchange-contract.mjs';

const sourceSha256 = 'a'.repeat(64);
const reviewerId = 'reviewer-local.1';
const payload = {
  type: 'highlight',
  page: 1,
  rectangle: { x: 1, y: 2, width: 30, height: 10 },
  text: 'Review this',
  status: 'open',
  customStatus: null,
  properties: {},
  mentions: [],
};

function delta() {
  const unsigned = {
    id: 'annotation-1', kind: 'annotation', annotationId: null, revision: 1,
    timestamp: '2026-07-21T10:00:00.000Z', status: 'open', authorId: reviewerId,
    text: '', payload: structuredClone(payload),
  };
  return { ...unsigned, sha256: reviewSharedExchangeDigest(unsigned) };
}

test('review exchange request and manifest are strict, canonical, and digest-bound', () => {
  assert.deepEqual(normalizeReviewSharedExchangeRequest({ reviewerId, baseRevision: 0 }, { sourceSha256, currentRevision: 2 }), { reviewerId, baseRevision: 0, sourceSha256 });
  const manifest = createReviewSharedExchangeManifest({ sourceSha256, baseRevision: 0, reviewerId, deltas: [delta()] });
  assert.deepEqual(parseReviewSharedExchangeManifest(structuredClone(manifest)), manifest);
  assert.throws(() => normalizeReviewSharedExchangeRequest({ reviewerId: 'person@example.com', baseRevision: 0 }, { sourceSha256 }), { code: 'INVALID_REVIEW_SHARED_EXCHANGE' });
  assert.throws(() => parseReviewSharedExchangeManifest({ ...manifest, payloadSha256: 'b'.repeat(64) }), { code: 'INVALID_REVIEW_SHARED_EXCHANGE' });
});

test('review exchange rejects accessors, symbols, proxies, and malformed delta hashes', () => {
  const accessor = {};
  Object.defineProperty(accessor, 'reviewerId', { enumerable: true, get: () => reviewerId });
  Object.defineProperty(accessor, 'baseRevision', { enumerable: true, value: 0 });
  assert.throws(() => normalizeReviewSharedExchangeRequest(accessor, { sourceSha256 }), { code: 'INVALID_REVIEW_SHARED_EXCHANGE' });
  const symbolValue = { reviewerId, baseRevision: 0 };
  symbolValue[Symbol('unexpected')] = true;
  assert.throws(() => normalizeReviewSharedExchangeRequest(symbolValue, { sourceSha256 }), { code: 'INVALID_REVIEW_SHARED_EXCHANGE' });
  const proxied = new Proxy({ reviewerId, baseRevision: 0 }, { ownKeys: () => ['reviewerId', 'baseRevision', 'extra'] });
  assert.throws(() => normalizeReviewSharedExchangeRequest(proxied, { sourceSha256 }), { code: 'INVALID_REVIEW_SHARED_EXCHANGE' });
  const item = delta();
  const manifest = createReviewSharedExchangeManifest({ sourceSha256, baseRevision: 0, reviewerId, deltas: [item] });
  assert.throws(() => parseReviewSharedExchangeDeltas({ schemaVersion: 1, deltas: [{ ...item, text: 'tampered' }] }, manifest), { code: 'INVALID_REVIEW_SHARED_EXCHANGE' });
  const nested = delta();
  Object.defineProperty(nested.payload.properties, 'sneaky', { enumerable: true, get: () => 'value' });
  assert.throws(() => createReviewSharedExchangeManifest({ sourceSha256, baseRevision: 0, reviewerId, deltas: [nested] }), { code: 'INVALID_REVIEW_SHARED_EXCHANGE' });
  const emailMention = delta(); emailMention.payload.mentions = ['reviewer-local', 'person@example.com'];
  assert.throws(() => createReviewSharedExchangeManifest({ sourceSha256, baseRevision: 0, reviewerId, deltas: [emailMention] }), { code: 'INVALID_REVIEW_SHARED_EXCHANGE' });
  const valid = delta(); const validManifest = createReviewSharedExchangeManifest({ sourceSha256, baseRevision: 0, reviewerId, deltas: [valid] });
  const accessorArray = []; Object.defineProperty(accessorArray, '0', { enumerable: true, get: () => valid }); accessorArray.length = 1;
  assert.throws(() => parseReviewSharedExchangeDeltas({ schemaVersion: 1, deltas: accessorArray }, validManifest), { code: 'INVALID_REVIEW_SHARED_EXCHANGE' });
});
