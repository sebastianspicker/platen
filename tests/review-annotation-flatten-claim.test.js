import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { handleAnnotationFlattenRoute } from '../scripts/host/routes/annotation-flatten-routes.mjs';
import { createAnnotationFlattenEndpoints } from '../src/core/local-host-annotation-flatten-endpoints.js';
import {
  ANNOTATION_FLATTEN_LIMITATIONS,
  ANNOTATION_FLATTEN_PROFILE,
} from '../src/core/pdf-annotation-flatten-contract.js';
import { annotationFlattenReadiness } from '../src/ui/editor-readiness-specialized.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const sourceSha256 = 'a'.repeat(64);
const outputSha256 = 'b'.repeat(64);
const target = Object.freeze({
  page: 1,
  annotationIndex: 0,
  fingerprint: 'c'.repeat(64),
  subtype: 'square',
});

function receipt() {
  const operation = {
    schemaVersion: 1,
    id: operationId,
    type: 'pdf-square-annotation-flatten',
    inputs: [{ documentId, sha256: sourceSha256, role: 'source' }],
    parameters: {
      profile: ANNOTATION_FLATTEN_PROFILE,
      page: 1,
      annotationIndex: 0,
      subtype: 'square',
    },
    expected: {
      pageCount: 1,
      flattenedAnnotationCount: 1,
      sourceUnchanged: true,
      closedClassicRevision: true,
      priorRevisionsAbsent: true,
      rasterized: false,
    },
    validation: {
      passed: true,
      validators: [
        'source-sha256',
        'private-source-copy',
        'raw-locator-appearance-compact-proof',
        'poppler-page-count-text-boxes',
        'poppler-render-equality-256px-all-pages',
        'pdfsig-output-unsigned',
        'artifact-sha256',
      ],
      pageCount: 1,
      outputSha256,
    },
    completedAt: '2026-08-02T00:00:00.000Z',
  };
  return {
    kind: 'pdf-square-annotation-flatten',
    sourceDigest: sourceSha256,
    artifact: {
      id: artifactId,
      documentId,
      displayName: 'source-square-annotation-flattened.pdf',
      mediaType: 'application/pdf',
      size: 1024,
      sha256: outputSha256,
      operation,
      createdAt: '2026-08-02T00:00:00.000Z',
    },
    flatten: {
      profile: ANNOTATION_FLATTEN_PROFILE,
      page: 1,
      annotationIndex: 0,
      subtype: 'square',
    },
    evidence: Object.fromEntries([
      'sourceDigestReverified',
      'locatorRederived',
      'normalAppearanceVerified',
      'appearancePromotedToPageContent',
      'annotationRemoved',
      'removedReferenceUnresolvable',
      'closedClassicRevision',
      'priorRevisionsAbsent',
      'pageCountMatched',
      'pageTextMatched',
      'pageBoxesMatched',
      'pageValidationRendersMatched',
      'outputUnsigned',
      'artifactDigestBound',
      'sourceUnchanged',
      'localOnly',
    ].map((key) => [key, true])),
    limitations: [...ANNOTATION_FLATTEN_LIMITATIONS],
  };
}

function readinessArgs(overrides = {}) {
  const annotation = { page: 1, annotationIndex: 0, fingerprint: 'c'.repeat(64), subtype: 'square' };
  const inspection = {
    sourceDigest: sourceSha256,
    pageCount: 1,
    pages: [{ index: 1, rotation: 0, annotationsTruncated: false, annotations: [annotation] }],
    optionalContent: { present: false },
    outline: { truncated: false, items: [] },
    pageLabels: { present: false },
  };
  const state = {
    selectedPage: 1,
    pdfkitExistingAnnotationIndex: '0',
    host: { annotationFlattenReady: true },
    analysis: {
      sha256: sourceSha256,
      inspection: {
        pageCount: 1,
        encrypted: 'no',
        form: 'none',
        javascript: 'no',
        tagged: 'no',
      },
      attachments: [],
    },
    ...overrides.state,
  };
  return {
    state,
    ready: true,
    unsigned: true,
    info: state.analysis.inspection,
    formKind: 'none',
    analysis: state.analysis,
    structure: { xmpMetadata: { present: false }, urls: [] },
    inspection: overrides.inspection ?? inspection,
    page: overrides.page ?? inspection.pages[0],
  };
}

test('annotation-flatten claim gate requires one inspected source-bound square', () => {
  assert.equal(annotationFlattenReadiness(readinessArgs()), true);
  const multiple = readinessArgs();
  multiple.inspection = {
    ...multiple.inspection,
    pages: [{ ...multiple.inspection.pages[0], annotations: [
      ...multiple.inspection.pages[0].annotations,
      { page: 1, annotationIndex: 1, fingerprint: 'd'.repeat(64), subtype: 'square' },
    ] }],
  };
  assert.equal(annotationFlattenReadiness(multiple), false);
  const truncated = readinessArgs();
  truncated.inspection = {
    ...truncated.inspection,
    pages: [{ ...truncated.inspection.pages[0], annotationsTruncated: true }],
  };
  assert.equal(annotationFlattenReadiness(truncated), false);
  const wrongSubtype = readinessArgs();
  wrongSubtype.inspection = {
    ...wrongSubtype.inspection,
    pages: [{ ...wrongSubtype.inspection.pages[0], annotations: [{ ...target, subtype: 'text' }] }],
  };
  wrongSubtype.page = wrongSubtype.inspection.pages[0];
  assert.equal(annotationFlattenReadiness(wrongSubtype), false);
});

test('annotation-flatten claim path preserves exact client-to-route contract and receipt limits', async () => {
  const calls = [];
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
  const processing = { signal: new AbortController().signal };
  const routeContext = {
    request: {},
    response,
    url: new URL(`http://local.test/api/documents/${documentId}/annotation-flatten`),
    documentId,
    operation: 'annotation-flatten',
    processing,
    store: { deleteArtifact: async (id) => calls.push(['delete', id]) },
    annotationFlatten: {
      flatten: async (...args) => {
        calls.push(['flatten', ...args]);
        return receipt();
      },
    },
    bodyLimit: 2048,
    exactJsonObject: (value, keys) => value && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && Object.keys(value).every((key) => keys.includes(key)),
    method: () => {},
    readJson: async () => JSON.parse(calls.find(([name]) => name === 'request')?.[1] ?? '{}'),
    json: (_response, status, payload) => calls.push(['json', status, payload]),
  };
  const client = createAnnotationFlattenEndpoints({
    json: async (_path, options) => {
      calls.push(['request', options.body]);
      await handleAnnotationFlattenRoute(routeContext);
      return calls.at(-1)[2];
    },
  });
  const result = await client.runAnnotationFlatten(documentId, sourceSha256, { target });
  assert.equal(result.kind, 'pdf-square-annotation-flatten');
  const request = calls.find(([name]) => name === 'request');
  assert.deepEqual(JSON.parse(request[1]), {
    profile: ANNOTATION_FLATTEN_PROFILE,
    sourceSha256,
    target,
  });
  const flatten = calls.find(([name]) => name === 'flatten');
  assert.equal(flatten[1], documentId);
  assert.deepEqual(flatten[2], {
    profile: ANNOTATION_FLATTEN_PROFILE,
    sourceSha256,
    target,
  });
  assert.equal(flatten[3].sourceSha256, sourceSha256);
  assert.equal(flatten[3].signal, processing.signal);
  assert.equal(calls.find(([name]) => name === 'json')[1], 201);

  const drifted = receipt();
  drifted.flatten.annotationIndex = 1;
  await assert.rejects(
    createAnnotationFlattenEndpoints({ json: async () => ({ result: drifted }) })
      .runAnnotationFlatten(documentId, sourceSha256, { target }),
    { code: 'INVALID_LOCAL_HOST' },
  );
});
