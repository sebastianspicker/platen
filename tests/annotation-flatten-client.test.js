import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANNOTATION_FLATTEN_LIMITATIONS,
  ANNOTATION_FLATTEN_PROFILE,
  ANNOTATION_FLATTEN_VALIDATORS,
  buildAnnotationFlattenMutation,
  validateAnnotationFlattenResult,
} from '../src/core/pdf-annotation-flatten-contract.js';
import { createAnnotationFlattenEndpoints } from '../src/core/local-host-annotation-flatten-endpoints.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64); const outputSha256 = 'b'.repeat(64);
const target = Object.freeze({ page: 1, annotationIndex: 0, fingerprint: 'c'.repeat(64), subtype: 'square' });

function result(changes = {}) {
  const operation = {
    schemaVersion: 1, id: operationId, type: 'pdf-square-annotation-flatten',
    inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
    parameters: { profile: ANNOTATION_FLATTEN_PROFILE, page: 1, annotationIndex: 0, subtype: 'square' },
    expected: { pageCount: 1, flattenedAnnotationCount: 1, sourceUnchanged: true, closedClassicRevision: true, priorRevisionsAbsent: true, rasterized: false },
    validation: { passed: true, validators: [...ANNOTATION_FLATTEN_VALIDATORS], pageCount: 1, outputSha256 },
    completedAt: '2026-07-20T12:00:00.000Z',
  };
  return {
    kind: 'pdf-square-annotation-flatten', sourceDigest: sourceSha256,
    artifact: { id: artifactId, documentId, displayName: 'source-square-annotation-flattened.pdf', mediaType: 'application/pdf', size: 1024, sha256: outputSha256, operation, createdAt: '2026-07-20T12:00:00.000Z' },
    flatten: { profile: ANNOTATION_FLATTEN_PROFILE, page: 1, annotationIndex: 0, subtype: 'square' },
    evidence: Object.fromEntries(['sourceDigestReverified', 'locatorRederived', 'normalAppearanceVerified', 'appearancePromotedToPageContent', 'annotationRemoved', 'removedReferenceUnresolvable', 'closedClassicRevision', 'priorRevisionsAbsent', 'pageCountMatched', 'pageTextMatched', 'pageBoxesMatched', 'pageValidationRendersMatched', 'outputUnsigned', 'artifactDigestBound', 'sourceUnchanged', 'localOnly'].map((key) => [key, true])),
    limitations: [...ANNOTATION_FLATTEN_LIMITATIONS], ...changes,
  };
}

test('annotation-flatten client sends only the exact source-bound target', async () => {
  const calls = [];
  const endpoints = createAnnotationFlattenEndpoints({ json: async (path, options) => { calls.push({ path, options }); return { result: result() }; } });
  const value = await endpoints.runAnnotationFlatten(documentId, sourceSha256, { target });
  assert.equal(value.kind, 'pdf-square-annotation-flatten');
  assert.equal(calls[0].path, `/api/documents/${documentId}/annotation-flatten`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { profile: ANNOTATION_FLATTEN_PROFILE, sourceSha256, target });
  assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)), ['profile', 'sourceSha256', 'target']);
});

test('annotation-flatten builder requires the sole selected source-bound square', () => {
  const state = { selectedPage: 1, pdfkitExistingAnnotationIndex: '0', analysis: { sha256: sourceSha256, inspection: { pageCount: 1 } }, pdfkitInspectionResult: { sourceDigest: sourceSha256, pageCount: 1, pages: [{ index: 1, annotationsTruncated: false, annotations: [target] }] } };
  assert.deepEqual(buildAnnotationFlattenMutation(state), { target });
  assert.throws(() => buildAnnotationFlattenMutation({ ...state, pdfkitExistingAnnotationIndex: '1' }));
  assert.throws(() => buildAnnotationFlattenMutation({ ...state, pdfkitInspectionResult: { ...state.pdfkitInspectionResult, pages: [{ ...state.pdfkitInspectionResult.pages[0], annotations: [target, { ...target, annotationIndex: 1 }] }] } }));
});

test('annotation-flatten result rejects provenance drift and private surface expansion', () => {
  assert.equal(validateAnnotationFlattenResult(result(), { documentId, sourceSha256, request: { target } }).kind, 'pdf-square-annotation-flatten');
  const leaked = result({ privatePath: '/tmp/input.pdf' });
  assert.throws(() => validateAnnotationFlattenResult(leaked, { documentId, sourceSha256, request: { target } }), { code: 'INVALID_LOCAL_HOST' });
  const drift = result(); drift.artifact.operation.parameters.fingerprint = target.fingerprint;
  assert.throws(() => validateAnnotationFlattenResult(drift, { documentId, sourceSha256, request: { target } }), { code: 'INVALID_LOCAL_HOST' });
});
