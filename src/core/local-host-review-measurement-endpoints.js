import {
  PDF_REVIEW_MEASUREMENT_PROFILE,
  normalizePdfReviewMeasurement,
  validatePdfReviewMeasurementResult,
} from '../../scripts/host/pdf-review-measurement-contract.mjs';
import { documentEndpointPath, postJson } from './local-host-endpoint-transport.js';
import { OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_ARTIFACT_BYTES = 129 * 1024 * 1024;

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}

function dense(value, minimum, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length: value.length }, (_, index) => descriptors[index]).every((descriptor) => descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true);
}

function timestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function finite(value, minimum = -1_000_000, maximum = 1_000_000) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function positiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validSource(source, digest, page) {
  return exact(source, ['sha256', 'page', 'displayBox', 'box', 'rotation', 'geometrySha256']) && source.sha256 === digest
    && source.page === page && source.displayBox === 'crop' && [0, 90, 180, 270].includes(source.rotation)
    && SHA256.test(source.geometrySha256 ?? '') && exact(source.box, ['left', 'bottom', 'right', 'top'])
    && finite(source.box.left) && finite(source.box.bottom) && finite(source.box.right) && finite(source.box.top)
    && source.box.left < source.box.right && source.box.bottom < source.box.top;
}

function validMeasurement(measurement, digest, request) {
  if (!exact(measurement, ['schemaVersion', 'id', 'type', 'source', 'calibrationId', 'calibration', 'kind', 'geometry', 'result', 'label', 'provenanceSha256', 'createdAt'])
    || measurement.schemaVersion !== 2 || measurement.type !== 'measurement' || !ID.test(measurement.id ?? '')
    || !validSource(measurement.source, digest, request.page) || measurement.calibrationId !== measurement.calibration?.id
    || !['distance', 'perimeter', 'area'].includes(measurement.kind) || !SHA256.test(measurement.provenanceSha256 ?? '')
    || typeof measurement.label !== 'string' || measurement.label.length < 1 || measurement.label.length > 160 || !timestamp(measurement.createdAt)) return false;
  const calibration = measurement.calibration;
  if (!exact(calibration, ['schemaVersion', 'id', 'type', 'source', 'segment', 'knownLength', 'metersPerPdfPoint', 'label', 'createdAt'])
    || calibration.schemaVersion !== 2 || calibration.type !== 'scale-calibration' || !ID.test(calibration.id ?? '')
    || !validSource(calibration.source, digest, request.page) || !dense(calibration.segment, 2, 2)
    || calibration.segment.some((point) => !exact(point, ['x', 'y']) || !finite(point.x) || !finite(point.y))
    || !exact(calibration.knownLength, ['value', 'unit']) || !finite(calibration.knownLength.value, Number.EPSILON, 1_000_000_000)
    || !['mm', 'cm', 'm', 'in', 'ft'].includes(calibration.knownLength.unit) || !positiveFinite(calibration.metersPerPdfPoint)
    || typeof calibration.label !== 'string' || calibration.label.length < 1 || !timestamp(calibration.createdAt)) return false;
  const geometry = measurement.geometry;
  if (!exact(geometry, ['space', 'points']) || geometry.space !== 'pdf-user-space-v1' || !dense(geometry.points, measurement.kind === 'distance' ? 2 : 3, 50)
    || geometry.points.some((point) => !exact(point, ['x', 'y']) || !finite(point.x) || !finite(point.y))) return false;
  const result = measurement.result;
  return exact(result, ['dimension', 'siValue', 'siUnit', 'displayValue', 'displayUnit'])
    && result.dimension === (measurement.kind === 'area' ? 'area' : 'length') && positiveFinite(result.siValue)
    && result.siUnit === (measurement.kind === 'area' ? 'm2' : 'm') && positiveFinite(result.displayValue)
    && typeof result.displayUnit === 'string' && result.displayUnit === request.displayUnit;
}

function validOperation(operation, { documentId, sourceSha256, measurement, receipt }) {
  if (!exact(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    || operation.schemaVersion !== 1 || !UUID.test(operation.id ?? '') || operation.type !== 'pdf-review-measurement'
    || !dense(operation.inputs, 1, 1) || !exact(operation.inputs[0], ['documentId', 'sha256', 'role'])
    || operation.inputs[0].documentId !== documentId || operation.inputs[0].sha256 !== sourceSha256 || operation.inputs[0].role !== 'source'
    || !exact(operation.parameters, ['measurementId', 'page', 'kind', 'calibrationId', 'profile'])
    || operation.parameters.measurementId !== measurement.id || operation.parameters.page !== measurement.source.page
    || operation.parameters.kind !== measurement.kind || operation.parameters.calibrationId !== measurement.calibrationId
    || operation.parameters.profile !== PDF_REVIEW_MEASUREMENT_PROFILE
    || !exact(operation.expected, ['pageCount', 'rasterized', 'nativeAnnotations', 'measurementDictionaryEmbedded'])
    || !Number.isSafeInteger(operation.expected.pageCount) || operation.expected.pageCount < 1 || operation.expected.pageCount > 100
    || operation.expected.rasterized !== false || operation.expected.nativeAnnotations !== receipt.annotationCount || operation.expected.measurementDictionaryEmbedded !== true
    || !exact(operation.validation, ['passed', 'validators', 'sourceSha256', 'outputSha256', 'pageCount', 'annotationCount'])
    || operation.validation.passed !== true || !dense(operation.validation.validators, 1, 64)
    || operation.validation.sourceSha256 !== sourceSha256 || operation.validation.outputSha256 !== receipt.outputSha256
    || operation.validation.pageCount !== receipt.pageCount || operation.validation.annotationCount !== receipt.annotationCount
    || !timestamp(operation.completedAt)) return false;
  return operation.validation.validators.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 128);
}

function validArtifact(artifact, context) {
  return exact(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== context.documentId && artifact.documentId === context.documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length > 0 && artifact.displayName.length <= 240
    && !/[\u0000-\u001f\u007f]/u.test(artifact.displayName) && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64 && artifact.size <= MAX_ARTIFACT_BYTES
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== context.sourceSha256 && timestamp(artifact.createdAt)
    && validOperation(artifact.operation, context);
}

function validReceipt(receipt, { sourceSha256, measurement }) {
  return exact(receipt, ['schema', 'version', 'profile', 'operation', 'sourceSha256', 'nativeOutputSha256', 'outputSha256', 'measurementId', 'page', 'kind', 'quantity', 'unit', 'calibrationId', 'annotationCount', 'annotationSubtypes', 'measurementDictionaryEmbedded', 'measurementDictionaryScope', 'sourcePrefixPreserved', 'pageCount'])
    && receipt.schema === 'platen-review-measurement-receipt-v1' && receipt.version === 1 && receipt.profile === PDF_REVIEW_MEASUREMENT_PROFILE
    && receipt.operation === 'applyReviewMeasurement' && receipt.sourceSha256 === sourceSha256 && SHA256.test(receipt.nativeOutputSha256 ?? '')
    && SHA256.test(receipt.outputSha256 ?? '') && receipt.measurementId === measurement.id && receipt.page === measurement.source.page
    && receipt.kind === measurement.kind && receipt.quantity === measurement.result.siValue && receipt.unit === measurement.result.siUnit
    && receipt.calibrationId === measurement.calibrationId && Number.isSafeInteger(receipt.annotationCount) && receipt.annotationCount >= 1 && receipt.annotationCount <= 50
    && dense(receipt.annotationSubtypes, 1, 50) && receipt.annotationSubtypes.every((entry) => entry === 'line' || entry === 'ink')
    && receipt.measurementDictionaryEmbedded === true && (receipt.measurementDictionaryScope === 'line-and-page-viewport' || receipt.measurementDictionaryScope === 'page-viewport')
    && receipt.sourcePrefixPreserved === true && Number.isSafeInteger(receipt.pageCount) && receipt.pageCount >= 1 && receipt.pageCount <= 100;
}

function invalidResult() {
  throw new TypeError('The local host returned an invalid source-bound review-measurement result.');
}

export function validateReviewMeasurementResult(result, { documentId, request } = {}) {
  let normalized;
  try { normalized = normalizePdfReviewMeasurement(request); } catch { invalidResult(); }
  if (!exact(result, ['kind', 'schemaVersion', 'sourceDigest', 'revision', 'measurement', 'artifact', 'receipt', 'evidence', 'limitations'])
    || result.sourceDigest !== normalized.sourceSha256 || result.revision !== normalized.expectedRevision) invalidResult();
  try { validatePdfReviewMeasurementResult(result); } catch { invalidResult(); }
  if (!validMeasurement(result.measurement, normalized.sourceSha256, normalized)
    || !validReceipt(result.receipt, { sourceSha256: normalized.sourceSha256, measurement: result.measurement })
    || result.receipt.outputSha256 !== result.artifact.sha256
    || !validArtifact(result.artifact, { documentId, sourceSha256: normalized.sourceSha256, measurement: result.measurement, receipt: result.receipt })
    || !dense(result.limitations, 1, 16) || result.limitations.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 240)) invalidResult();
  return deepFreeze(result);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createReviewMeasurementEndpoints({ json }) {
  if (typeof json !== 'function') throw new TypeError('Review-measurement endpoints require a JSON transport.');
  return Object.freeze({
    createReviewMeasurement(documentId, request, options = {}) {
      const optionKeys = options?.signal === undefined ? [] : ['signal'];
      if (!OPAQUE_ID_PATTERN.test(documentId ?? '') || !exact(options, optionKeys) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError('Review-measurement options are invalid.');
      let normalized;
      try { normalized = normalizePdfReviewMeasurement(request); } catch { throw new TypeError('Review-measurement options are invalid.'); }
      return postJson(json, documentEndpointPath(documentId, '/review-measurement'), normalized, options.signal)
        .then((body) => validateReviewMeasurementResult(body?.result, { documentId, request: normalized }));
    },
  });
}
