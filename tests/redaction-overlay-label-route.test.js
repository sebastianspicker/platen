import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { HostError } from '../scripts/host/host-error.mjs';
import { handleRedactionOverlayLabelRoute } from '../scripts/host/routes/redaction-overlay-label-routes.mjs';
import {
  REDACTION_OVERLAY_LABEL_LIMITATIONS,
  REDACTION_OVERLAY_LABEL_PROFILE,
} from '../src/core/pdf-redaction-overlay-label-contract.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const label = 'REDACTED';
const labelContentsSha256 = createHash('sha256').update(`OVERLAY_LABEL:${label}`).digest('hex');

const body = Object.freeze({
  profile: REDACTION_OVERLAY_LABEL_PROFILE,
  sourceSha256,
  page: 2,
  label,
});

function result({ forged = false, leaky = false } = {}) {
  const resultDocumentId = forged ? 'other-document' : documentId;
  const artifact = {
    id: artifactId,
    documentId: resultDocumentId,
    displayName: 'source-redaction-overlay-label.pdf',
    mediaType: 'application/pdf',
    size: 128,
    sha256: outputSha256,
    operation: {
      schemaVersion: 1,
      id: '33333333-3333-4333-8333-333333333333',
      type: 'pdf-redaction-overlay-label',
      inputs: [{ documentId: resultDocumentId, sha256: sourceSha256, role: 'source' }],
      parameters: { profile: REDACTION_OVERLAY_LABEL_PROFILE, page: body.page, labelContentsSha256 },
      expected: { sourceUnchanged: true, fullPageContentRemoved: true, labelAnnotationStored: true },
      validation: {
        passed: true,
        validators: ['source-sha256', 'closed-redaction-base', 'label-contents-digest'],
        outputSha256,
      },
      completedAt: '2026-08-04T00:00:00.000Z',
    },
    createdAt: '2026-08-04T00:00:00.000Z',
  };
  const value = {
    kind: 'pdf-redaction-overlay-label',
    profile: REDACTION_OVERLAY_LABEL_PROFILE,
    documentId: resultDocumentId,
    sourceSha256,
    page: body.page,
    label,
    labelContentsSha256,
    artifact,
    evidence: {
      sourceDigestReverified: true,
      sourceUnchanged: true,
      fullPageContentRemoved: true,
      closedRedactionBase: true,
      labelAnnotationStored: true,
      labelContentsDigestBound: true,
      artifactDigestBound: true,
      localOnly: true,
    },
    limitations: [...REDACTION_OVERLAY_LABEL_LIMITATIONS],
  };
  if (leaky) value.pdf = Buffer.from('secret');
  return value;
}

function context({ service = true, read = body, query = '', method = 'POST', disconnected = false } = {}) {
  const response = Object.assign(new EventEmitter(), { destroyed: disconnected, writableEnded: false });
  const controller = new AbortController();
  const calls = [];
  const deleted = [];
  return {
    calls,
    deleted,
    controller,
    response,
    request: { method },
    url: new URL(`http://local/api/documents/${documentId}/redaction-overlay-label${query}`),
    documentId,
    operation: 'redaction-overlay-label',
    processing: { signal: controller.signal },
    store: { async deleteArtifact(id) { deleted.push(id); } },
    redactionOverlayLabels: service ? {
      async apply(...args) {
        calls.push(args);
        return result();
      },
    } : null,
    bodyLimit: 1024,
    exactJsonObject(value, keys) {
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
    },
    method(requestValue, expected) { assert.equal(requestValue.method, expected); },
    async readJson() { return read; },
    json(_response, status, value) { response.status = status; response.value = value; },
  };
}

test('redaction overlay-label route forwards normalized request and returns the validated result', async () => {
  const value = context();
  assert.equal(await handleRedactionOverlayLabelRoute(value), true);
  assert.equal(value.response.status, 201);
  assert.deepEqual(value.response.value, { result: result() });
  assert.equal(value.calls.length, 1);
  assert.equal(value.calls[0][0], documentId);
  assert.deepEqual(value.calls[0][1], body);
  assert.equal(value.calls[0][2].signal, value.processing.signal);
});

test('redaction overlay-label route requires POST, no query, and the exact normalized body', async () => {
  await assert.rejects(handleRedactionOverlayLabelRoute(context({ method: 'GET' })), /Expected values to be strictly equal/);
  await assert.rejects(handleRedactionOverlayLabelRoute(context({ query: '?page=1' })), { code: 'INVALID_PARAMETER', status: 400 });
  for (const invalid of [
    { ...body, extra: true },
    { ...body, profile: 'other' },
    { ...body, sourceSha256: sourceSha256.toUpperCase() },
    { ...body, page: 0 },
    { ...body, label: '' },
    { ...body, label: 'private/path' },
  ]) {
    await assert.rejects(handleRedactionOverlayLabelRoute(context({ read: invalid })), { code: 'INVALID_REDACTION_OVERLAY_LABEL_OPTIONS', status: 400 });
  }
});

test('redaction overlay-label route fails closed when unavailable and preserves service failures', async () => {
  await assert.rejects(handleRedactionOverlayLabelRoute(context({ service: false })), { code: 'REDACTION_OVERLAY_LABEL_UNAVAILABLE', status: 503 });

  const mismatch = context();
  mismatch.redactionOverlayLabels.apply = async () => {
    throw new HostError('SOURCE_VERSION_MISMATCH', 'source changed', 409);
  };
  await assert.rejects(handleRedactionOverlayLabelRoute(mismatch), { code: 'SOURCE_VERSION_MISMATCH', status: 409 });

  const cancelled = context();
  cancelled.redactionOverlayLabels.apply = async (_documentId, _request, options) => {
    assert.equal(options.signal, cancelled.processing.signal);
    throw Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' });
  };
  await assert.rejects(handleRedactionOverlayLabelRoute(cancelled), { code: 'JOB_CANCELLED' });
});

test('redaction overlay-label route maps forged and leaky output and hostile input to bounded errors', async () => {
  for (const forged of [result({ forged: true }), result({ leaky: true }), { ...result(), labelContentsSha256: 'c'.repeat(64) }]) {
    const value = context();
    value.redactionOverlayLabels.apply = async () => forged;
    await assert.rejects(handleRedactionOverlayLabelRoute(value), { code: 'REDACTION_OVERLAY_LABEL_OUTPUT_INVALID', status: 502 });
  }

  const hostile = new Proxy({}, {
    ownKeys() { throw new Error('poisoned keys'); },
    get() { throw new Error('poisoned property'); },
  });
  await assert.rejects(handleRedactionOverlayLabelRoute(context({ read: hostile })), { code: 'INVALID_REDACTION_OVERLAY_LABEL_OPTIONS', status: 400 });
});

test('redaction overlay-label route revokes an undelivered artifact and retains a delivered one', async () => {
  const disconnected = context({ disconnected: true });
  assert.equal(await handleRedactionOverlayLabelRoute(disconnected), true);
  assert.deepEqual(disconnected.deleted, [artifactId]);
  assert.equal(disconnected.response.status, undefined);

  const delivered = context();
  await handleRedactionOverlayLabelRoute(delivered);
  delivered.response.emit('finish');
  delivered.response.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered.deleted, []);
});
