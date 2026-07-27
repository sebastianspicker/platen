import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INCREMENTAL_BLEED_BOX_PROFILE,
  INCREMENTAL_BLEED_BOX_VALIDATORS,
  INCREMENTAL_BLEED_BOX_LIMITATIONS,
  validateIncrementalBleedBoxResult,
} from '../src/core/pdf-incremental-bleed-box-contract.js';
import { LocalHostClient } from '../src/core/local-host-client.js';
import { PDF_INCREMENTAL_BLEED_BOX_LIMITATIONS } from '../scripts/host/pdf-incremental-bleed-box-artifact.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const token = 'c'.repeat(64);
const timestamp = '2026-07-19T12:00:00.000Z';
const request = Object.freeze({
  page: 2,
  rect: Object.freeze({ x: 10, y: 20, width: 580, height: 740 }),
});

function result() {
  return {
    kind: 'pdf-incremental-bleed-box',
    sourceDigest: sourceSha256,
    artifact: {
      id: artifactId,
      documentId,
      displayName: 'source-bleed-box.pdf',
      mediaType: 'application/pdf',
      size: 1_024,
      sha256: outputSha256,
      operation: {
        schemaVersion: 1,
        id: operationId,
        type: 'pdf-incremental-bleed-box',
        inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
        parameters: { profile: INCREMENTAL_BLEED_BOX_PROFILE, ...structuredClone(request) },
        expected: {
          pageCount: 2,
          sourceUnchanged: true,
          sourcePrefixPreserved: true,
          samePageObjectRevision: true,
          rasterized: false,
        },
        validation: {
          passed: true,
          validators: [...INCREMENTAL_BLEED_BOX_VALIDATORS],
          pageCount: 2,
          outputSha256,
        },
        completedAt: timestamp,
      },
      createdAt: timestamp,
    },
    pageBox: { profile: INCREMENTAL_BLEED_BOX_PROFILE, ...structuredClone(request) },
    evidence: {
      sourceDigestReverified: true,
      sourcePrefixPreserved: true,
      onlyTargetBleedBoxChanged: true,
      samePageObjectRevision: true,
      classicIncrementalRevisionAppended: true,
      pageCountMatched: true,
      pageTextMatched: true,
      nonTargetPageBoxesMatched: true,
      selectedMediaCropTrimArtMatched: true,
      selectedBleedBoxMatched: true,
      pageValidationRendersMatched: true,
      outputUnsigned: true,
      xmpAbsent: true,
      artifactDigestBound: true,
      sourceUnchanged: true,
      localOnly: true,
    },
    limitations: [...INCREMENTAL_BLEED_BOX_LIMITATIONS],
  };
}

test('incremental BleedBox client limitations exactly match the raw artifact limitations', () => {
  assert.deepEqual(INCREMENTAL_BLEED_BOX_LIMITATIONS, PDF_INCREMENTAL_BLEED_BOX_LIMITATIONS);
});

test('incremental BleedBox client sends and validates the exact source-bound profile', async () => {
  const calls = [];
  const controller = new AbortController();
  const client = new LocalHostClient({ fetchImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/bootstrap') {
      return new Response(JSON.stringify({ sessionToken: token }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: result() }), { status: 201 });
  } });
  await client.bootstrap();
  const value = await client.runIncrementalBleedBox(
    documentId, sourceSha256, request, { signal: controller.signal },
  );
  assert.equal(value.kind, 'pdf-incremental-bleed-box');
  assert.equal(calls[1].path, `/api/documents/${documentId}/incremental-bleed-box`);
  assert.equal(calls[1].options.signal, controller.signal);
  assert.equal(calls[1].options.headers['X-Platen-Token'], token);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    profile: INCREMENTAL_BLEED_BOX_PROFILE,
    sourceSha256,
    ...request,
  });
  assert.throws(() => client.runIncrementalBleedBox(
    documentId, sourceSha256.toUpperCase(), request,
  ), TypeError);
  assert.throws(() => client.runIncrementalBleedBox(
    documentId, sourceSha256, { ...request, page: 0 },
  ), TypeError);
  assert.throws(() => client.runIncrementalBleedBox(
    documentId, sourceSha256, { ...request, rect: { ...request.rect, width: 1.5 } },
  ), TypeError);
});

test('incremental BleedBox client rejects crossed request, provenance, and evidence', () => {
  const context = { documentId, sourceSha256, request };
  assert.equal(validateIncrementalBleedBoxResult(result(), context).kind, 'pdf-incremental-bleed-box');
  const corruptions = [
    (value) => { value.sourceDigest = '0'.repeat(64); },
    (value) => { value.artifact.documentId = artifactId; },
    (value) => { value.pageBox.rect.width -= 1; },
    (value) => { value.artifact.operation.parameters.page = 1; },
    (value) => { value.artifact.operation.validation.validators.pop(); },
    (value) => { value.artifact.operation.validation.outputSha256 = '0'.repeat(64); },
    (value) => { value.evidence.onlyTargetBleedBoxChanged = false; },
    (value) => { value.limitations[2] = 'Validation equality is broader than the fixed 256-pixel-long-edge check.'; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(result());
    corrupt(candidate);
    assert.throws(() => validateIncrementalBleedBoxResult(candidate, context), {
      code: 'INVALID_LOCAL_HOST',
    });
  }
});
