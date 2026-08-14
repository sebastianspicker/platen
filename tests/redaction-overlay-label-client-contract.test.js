import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  REDACTION_OVERLAY_LABEL_LIMITATIONS,
  REDACTION_OVERLAY_LABEL_PROFILE,
  normalizeRedactionOverlayLabelRequest,
  validateRedactionOverlayLabelResult,
} from '../src/core/pdf-redaction-overlay-label-contract.js';
import { createRedactionOverlayLabelEndpoints } from '../src/core/local-host-redaction-overlay-label-endpoints.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const timestamp = '2026-08-04T12:00:00.000Z';

const labelDigest = (label) => createHash('sha256').update(`REDACTION_LABEL:${label}`).digest('hex');

function request(label = 'REDACTED') {
  return { profile: REDACTION_OVERLAY_LABEL_PROFILE, sourceSha256, page: 1, label };
}

function result() {
  const label = 'REDACTED';
  const contentsSha256 = labelDigest(label);
  const operation = {
    schemaVersion: 1,
    id: operationId,
    type: 'pdf-redaction-overlay-label',
    inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
    parameters: { profile: REDACTION_OVERLAY_LABEL_PROFILE, page: 1, labelContentsSha256: contentsSha256 },
    expected: { sourceUnchanged: true, fullPageContentRemoved: true, labelAnnotationStored: true },
    validation: {
      passed: true,
      validators: ['source-sha256', 'private-source-copy', 'full-page-redaction', 'label-annotation', 'artifact-sha256'],
      outputSha256,
    },
    completedAt: timestamp,
  };
  return {
    kind: 'pdf-redaction-overlay-label',
    profile: REDACTION_OVERLAY_LABEL_PROFILE,
    documentId,
    sourceSha256,
    page: 1,
    label,
    labelContentsSha256: contentsSha256,
    artifact: {
      id: artifactId,
      documentId,
      displayName: 'source-redaction-overlay-label.pdf',
      mediaType: 'application/pdf',
      size: 1024,
      sha256: outputSha256,
      operation,
      createdAt: timestamp,
    },
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
}

test('normalizes strict requests into deeply frozen plain data', () => {
  const input = request('Résumé');
  const normalized = normalizeRedactionOverlayLabelRequest(input);
  assert.deepEqual(normalized, input);
  assert.equal(Object.isFrozen(normalized), true);
  assert.throws(() => { normalized.label = 'changed'; }, TypeError);
  for (const value of [
    { ...request(), page: 0 }, { ...request(), page: 101 }, { ...request(), label: '' },
    { ...request(), label: 'a'.repeat(41) }, { ...request(), label: 'e\u0301' },
    { ...request(), label: 'bad/path' }, { ...request(), label: 'bad\\path' },
    { ...request(), label: 'bad\u0000label' }, { ...request(), sourceSha256: 'A'.repeat(64) },
  ]) assert.throws(() => normalizeRedactionOverlayLabelRequest(value), TypeError);
  const accessor = {}; Object.defineProperty(accessor, 'profile', { enumerable: true, get() { throw new Error('getter'); } });
  Object.assign(accessor, { sourceSha256, page: 1, label: 'REDACTED' });
  assert.throws(() => normalizeRedactionOverlayLabelRequest(accessor), TypeError);
  const proxy = new Proxy(request(), { ownKeys() { throw new Error('hostile ownKeys'); } });
  assert.throws(() => normalizeRedactionOverlayLabelRequest(proxy), TypeError);
});

test('sends the exact source-bound transport and validates the result', async () => {
  const calls = [];
  const controller = new AbortController();
  const endpoints = createRedactionOverlayLabelEndpoints({
    json: async (path, options) => { calls.push({ path, options }); return { result: result() }; },
  });
  const value = await endpoints.applyRedactionOverlayLabel(documentId, request(), { signal: controller.signal });
  assert.equal(value.kind, 'pdf-redaction-overlay-label');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/documents/${documentId}/redaction-overlay-label`);
  assert.deepEqual(JSON.parse(calls[0].options.body), request());
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.throws(() => endpoints.applyRedactionOverlayLabel(documentId, request(), { extra: true }), TypeError);
});

test('rejects forged, leaky, and hostile result data', () => {
  assert.equal(validateRedactionOverlayLabelResult(result(), { documentId, sourceSha256, request: request() }).kind, 'pdf-redaction-overlay-label');
  const corruptions = [
    (value) => { value.artifact.documentId = '44444444-4444-4444-8444-444444444444'; },
    (value) => { value.artifact.operation.inputs[0].sha256 = '0'.repeat(64); },
    (value) => { value.artifact.operation.validation.outputSha256 = '0'.repeat(64); },
    (value) => { value.artifact.displayName = '/private/tmp/output.pdf'; },
    (value) => { value.labelContentsSha256 = '0'.repeat(64); },
    (value) => { value.evidence.localOnly = false; },
    (value) => { value.limitations[0] = 'General redaction.'; },
    (value) => { value.artifact.operation.parameters.page = 2; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(result());
    corrupt(candidate);
    assert.throws(() => validateRedactionOverlayLabelResult(candidate, { documentId, sourceSha256, request: request() }), { code: 'INVALID_LOCAL_HOST' });
  }
});
