import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  PDF_REVIEW_MEASUREMENT_PROFILE,
  normalizePdfReviewMeasurement,
} from '../scripts/host/pdf-review-measurement-contract.mjs';
import { calculatePdfReviewMeasurement } from '../scripts/host/pdf-review-measurement-service.mjs';
import { handleReviewMeasurementRoute } from '../scripts/host/routes/review-measurement-routes.mjs';
import {
  createReviewMeasurementEndpoints,
  validateReviewMeasurementResult,
} from '../src/core/local-host-review-measurement-endpoints.js';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const ARTIFACT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE = 'a'.repeat(64);
const NATIVE_OUTPUT = 'b'.repeat(64);
const OUTPUT = 'c'.repeat(64);

function request() {
  return {
    profile: PDF_REVIEW_MEASUREMENT_PROFILE,
    sourceSha256: SOURCE,
    expectedRevision: 7,
    id: 'review-1',
    page: 1,
    kind: 'distance',
    points: [{ x: 72, y: 72 }, { x: 144, y: 72 }],
    calibration: { id: 'scale-1', points: [{ x: 72, y: 72 }, { x: 144, y: 72 }], realLength: 1, unit: 'ft' },
    label: 'Wall length',
    displayUnit: 'ft',
  };
}

function resultFor(input = request()) {
  const binding = { sha256: SOURCE, page: 1, displayBox: 'crop', box: { left: 0, bottom: 0, right: 612, top: 792 }, rotation: 0, geometrySha256: 'd'.repeat(64) };
  const measurement = calculatePdfReviewMeasurement(input, binding).measurement;
  const receipt = {
    schema: 'platen-review-measurement-receipt-v1', version: 1, profile: PDF_REVIEW_MEASUREMENT_PROFILE, operation: 'applyReviewMeasurement',
    sourceSha256: SOURCE, nativeOutputSha256: NATIVE_OUTPUT, outputSha256: OUTPUT, measurementId: measurement.id, page: 1, kind: measurement.kind,
    quantity: measurement.result.siValue, unit: measurement.result.siUnit, calibrationId: measurement.calibrationId, annotationCount: 1,
    annotationSubtypes: ['line'], measurementDictionaryEmbedded: true, measurementDictionaryScope: 'line-and-page-viewport', sourcePrefixPreserved: true, pageCount: 1,
  };
  const operation = {
    schemaVersion: 1, id: OPERATION_ID, type: 'pdf-review-measurement', inputs: [{ documentId: DOCUMENT_ID, sha256: SOURCE, role: 'source' }],
    parameters: { measurementId: measurement.id, page: 1, kind: measurement.kind, calibrationId: measurement.calibrationId, profile: PDF_REVIEW_MEASUREMENT_PROFILE },
    expected: { pageCount: 1, rasterized: false, nativeAnnotations: 1, measurementDictionaryEmbedded: true },
    validation: { passed: true, validators: ['source-sha256', 'artifact-sha256'], sourceSha256: SOURCE, outputSha256: OUTPUT, pageCount: 1, annotationCount: 1 },
    completedAt: '2026-08-03T00:00:00.000Z',
  };
  return {
    kind: 'pdf-review-measurement', schemaVersion: 1, sourceDigest: SOURCE, revision: 7, measurement,
    artifact: { id: ARTIFACT_ID, documentId: DOCUMENT_ID, displayName: 'drawing-review-measurement.pdf', mediaType: 'application/pdf', size: 128, sha256: OUTPUT, operation, createdAt: '2026-08-03T00:00:00.000Z' },
    receipt,
    evidence: { localOnly: true, sourceBound: true, nativeAnnotations: true, helperReopened: true, popplerParsed: true, allPagesRendered: true, sourceUnchanged: true },
    limitations: ['Local review measurement only.'],
  };
}

function exactJsonObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

test('review measurement claim uses the exact calibrated eligible-local-PDF profile and retains a bound receipt/artifact', () => {
  const value = request();
  const normalized = normalizePdfReviewMeasurement(value);
  assert.equal(normalized.profile, PDF_REVIEW_MEASUREMENT_PROFILE);
  assert.equal(Object.hasOwn(normalized, 'quantity'), false);
  const result = resultFor(normalized);
  const checked = validateReviewMeasurementResult(result, { documentId: DOCUMENT_ID, request: normalized });
  assert.equal(Object.isFrozen(checked), true);
  assert.equal(Object.isFrozen(checked.measurement), true);
  assert.equal(checked.receipt.sourceSha256, SOURCE);
  assert.equal(checked.receipt.outputSha256, checked.artifact.sha256);
  assert.equal(checked.artifact.mediaType, 'application/pdf');
  assert.equal(Object.hasOwn(checked.artifact, 'filePath'), false);
  assert.throws(() => normalizePdfReviewMeasurement({ ...value, profile: 'wrong-profile' }), { code: 'INVALID_PDF_REVIEW_MEASUREMENT' });
});

test('review measurement route passes the current source and AbortSignal, validates output, and cleans up on disconnect or forged output', async () => {
  const controller = new AbortController();
  const result = resultFor();
  const deleted = [];
  const response = new EventEmitter(); response.destroyed = false;
  let payload;
  const context = {
    request: { method: 'POST' }, response, url: new URL(`http://local/api/documents/${DOCUMENT_ID}/review-measurement`), documentId: DOCUMENT_ID,
    operation: 'review-measurement', processing: { signal: controller.signal }, store: { getDocument: () => ({ sha256: SOURCE }), getArtifact: () => result.artifact, deleteArtifact: async (id) => deleted.push(id) },
    reviewMeasurement: { create: async (_id, body, options) => { assert.deepEqual(body, normalizePdfReviewMeasurement(request())); assert.equal(options.sourceSha256, SOURCE); assert.equal(options.signal, controller.signal); return result; } },
    method: (req, expected) => assert.equal(req.method, expected), readJson: async () => request(), json: (_response, status, value) => { assert.equal(status, 201); payload = value; },
    exactJsonObject, bodyLimit: 8_192,
  };
  assert.equal(await handleReviewMeasurementRoute(context), true);
  assert.equal(payload.result, result);
  response.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deleted, [ARTIFACT_ID]);

  const forged = resultFor(); forged.artifact.filePath = '/private/secret.pdf';
  const forgedContext = { ...context, response: new EventEmitter(), reviewMeasurement: { create: async () => forged }, json: () => { throw new Error('must not respond'); } };
  await assert.rejects(handleReviewMeasurementRoute(forgedContext), { code: 'PDF_REVIEW_MEASUREMENT_OUTPUT_INVALID', status: 502 });
  assert.deepEqual(deleted, [ARTIFACT_ID, ARTIFACT_ID]);
});

test('review measurement client forwards cancellation and freezes strict returned result', async () => {
  const controller = new AbortController();
  let call;
  const client = createReviewMeasurementEndpoints({ json: async (path, options) => { call = { path, options }; return { result: resultFor() }; } });
  const result = await client.createReviewMeasurement(DOCUMENT_ID, request(), { signal: controller.signal });
  assert.equal(call.path, `/api/documents/${DOCUMENT_ID}/review-measurement`);
  assert.equal(call.options.signal, controller.signal);
  assert.equal(JSON.parse(call.options.body).profile, PDF_REVIEW_MEASUREMENT_PROFILE);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.artifact.operation), true);
  assert.throws(() => client.createReviewMeasurement(DOCUMENT_ID, request(), { signal: {} }), TypeError);
  assert.throws(() => validateReviewMeasurementResult({ ...result, artifact: { ...result.artifact, filePath: '/private/secret.pdf' } }, { documentId: DOCUMENT_ID, request: request() }), TypeError);
});
