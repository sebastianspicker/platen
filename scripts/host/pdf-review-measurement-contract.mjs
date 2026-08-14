import { deepFreeze, UNIT_METERS } from './aec-artifact-validation.mjs';

export const PDF_REVIEW_MEASUREMENT_PROFILE = 'platen-review-measurement-v1';
export const REVIEW_MEASUREMENT_PROFILE = PDF_REVIEW_MEASUREMENT_PROFILE;
export const REVIEW_MEASUREMENT_KINDS = Object.freeze(['distance', 'perimeter', 'area']);
export const REVIEW_LENGTH_UNITS = Object.freeze(['mm', 'cm', 'm', 'in', 'ft']);
export const REVIEW_AREA_UNITS = Object.freeze(['mm2', 'cm2', 'm2', 'in2', 'ft2']);
export const REVIEW_MEASUREMENT_LIMITS = Object.freeze({
  maxPages: 100,
  maxPoints: 50,
  maxLabelBytes: 160,
  maxSourceBytes: 128 * 1024 * 1024,
  maxOutputBytes: 256 * 1024 * 1024,
});

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const encoder = new TextEncoder();

function invalid(message = 'Review measurement request is invalid.') {
  const error = new TypeError(message);
  error.code = 'INVALID_PDF_REVIEW_MEASUREMENT';
  throw error;
}

function cloneable(value) {
  try { structuredClone(value); return true; } catch { return false; }
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${label} must be a plain, data-only object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) {
    invalid(`${label} must contain exactly the supported data fields.`);
  }
  if (!cloneable(value)) invalid(`${label} must be a plain, data-only object.`);
  return descriptors;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} is outside the supported range.`);
  return value;
}

function finite(value, label, minimum = -1_000_000, maximum = 1_000_000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalid(`${label} must be a bounded finite number.`);
  return value === 0 ? 0 : value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) invalid(`${label} must be a bounded opaque identifier.`);
  return value;
}

function label(value) {
  if (typeof value !== 'string' || !value.trim() || encoder.encode(value).byteLength > REVIEW_MEASUREMENT_LIMITS.maxLabelBytes) invalid('label must be bounded non-empty text.');
  if ([...value].some((character) => character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f)) invalid('label contains a control character.');
  return value.trim();
}

function point(value, path) {
  const descriptors = exactObject(value, ['x', 'y'], path);
  return Object.freeze({ x: finite(descriptors.x.value, `${path}.x`), y: finite(descriptors.y.value, `${path}.y`) });
}

function points(value, path, minimum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > REVIEW_MEASUREMENT_LIMITS.maxPoints) invalid(`${path} must contain ${minimum} through ${REVIEW_MEASUREMENT_LIMITS.maxPoints} points.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0 || Object.keys(descriptors).length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) invalid(`${path} must be a dense data-only array.`);
  if (Object.entries(descriptors).some(([key, descriptor]) => key !== 'length' && (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) || !cloneable(value)) invalid(`${path} must be a dense data-only array.`);
  return Object.freeze(value.map((entry, index) => point(entry, `${path}[${index}]`)));
}

function normalizeCalibration(value) {
  const descriptors = exactObject(value, ['id', 'points', 'realLength', 'unit'], 'calibration');
  const unit = descriptors.unit.value;
  if (!REVIEW_LENGTH_UNITS.includes(unit)) invalid('calibration.unit is unsupported.');
  const realLength = finite(descriptors.realLength.value, 'calibration.realLength', Number.EPSILON, 1_000_000_000);
  const segment = points(descriptors.points.value, 'calibration.points', 2);
  if (segment.length !== 2 || (segment[0].x === segment[1].x && segment[0].y === segment[1].y)) invalid('calibration.points must be two distinct points.');
  return Object.freeze({ id: identifier(descriptors.id.value, 'calibration.id'), points: segment, realLength, unit });
}

export function normalizePdfReviewMeasurement(value) {
  const descriptors = exactObject(value, ['profile', 'sourceSha256', 'expectedRevision', 'id', 'page', 'kind', 'points', 'calibration', 'label', 'displayUnit'], 'review measurement');
  if (descriptors.profile.value !== PDF_REVIEW_MEASUREMENT_PROFILE) invalid('profile is unsupported.');
  const kind = descriptors.kind.value;
  if (!REVIEW_MEASUREMENT_KINDS.includes(kind)) invalid('Only distance, perimeter, and area measurements are supported.');
  const displayUnit = descriptors.displayUnit.value;
  const isArea = kind === 'area';
  const allowedUnits = isArea ? REVIEW_AREA_UNITS : REVIEW_LENGTH_UNITS;
  if (!allowedUnits.includes(displayUnit)) invalid('displayUnit does not match the measurement dimension.');
  const minimum = kind === 'distance' ? 2 : 3;
  const normalized = {
    profile: PDF_REVIEW_MEASUREMENT_PROFILE,
    sourceSha256: digest(descriptors.sourceSha256.value, 'sourceSha256'),
    expectedRevision: integer(descriptors.expectedRevision.value, 'expectedRevision', 0, 1_000_000),
    id: identifier(descriptors.id.value, 'id'),
    page: integer(descriptors.page.value, 'page', 1, REVIEW_MEASUREMENT_LIMITS.maxPages),
    kind,
    points: points(descriptors.points.value, 'points', minimum),
    calibration: normalizeCalibration(descriptors.calibration.value),
    label: label(descriptors.label.value),
    displayUnit,
  };
  return deepFreeze(normalized);
}

export const normalizeReviewMeasurement = normalizePdfReviewMeasurement;

export function validatePdfReviewMeasurementResult(value) {
  const descriptors = exactObject(value, ['kind', 'schemaVersion', 'sourceDigest', 'revision', 'measurement', 'artifact', 'receipt', 'evidence', 'limitations'], 'review measurement result');
  if (descriptors.kind.value !== 'pdf-review-measurement' || descriptors.schemaVersion.value !== 1) invalid('review measurement result kind or schemaVersion is invalid.');
  digest(descriptors.sourceDigest.value, 'sourceDigest');
  integer(descriptors.revision.value, 'revision', 0, 1_000_000);
  if (!descriptors.measurement.value || typeof descriptors.measurement.value !== 'object') invalid('measurement result is required.');
  const measurement = descriptors.measurement.value;
  if (measurement.schemaVersion !== 2 || measurement.type !== 'measurement' || !REVIEW_MEASUREMENT_KINDS.includes(measurement.kind)
    || measurement.source?.sha256 !== descriptors.sourceDigest.value || measurement.calibrationId !== measurement.calibration?.id
    || measurement.geometry?.space !== 'pdf-user-space-v1' || !Number.isFinite(measurement.result?.siValue)
    || !['m', 'm2'].includes(measurement.result?.siUnit)) invalid('measurement result is inconsistent or not source-bound.');
  if (!descriptors.artifact.value || typeof descriptors.artifact.value !== 'object' || !SHA256.test(descriptors.artifact.value.sha256 ?? '')) invalid('artifact digest is invalid.');
  if (!descriptors.receipt.value || typeof descriptors.receipt.value !== 'object' || descriptors.receipt.value.outputSha256 !== descriptors.artifact.value.sha256 || descriptors.receipt.value.sourceSha256 !== descriptors.sourceDigest.value) invalid('receipt is not source/output bound.');
  const receipt = descriptors.receipt.value;
  if (receipt.measurementId !== measurement.id || receipt.page !== measurement.source.page || receipt.kind !== measurement.kind
    || receipt.quantity !== measurement.result.siValue || receipt.unit !== measurement.result.siUnit
    || receipt.calibrationId !== measurement.calibrationId || receipt.measurementDictionaryEmbedded !== true
    || !Number.isSafeInteger(receipt.annotationCount) || receipt.annotationCount < 1 || receipt.annotationCount > 50
    || !Array.isArray(receipt.annotationSubtypes) || receipt.annotationSubtypes.length < 1
    || receipt.annotationSubtypes.some((entry) => !['line', 'ink'].includes(entry))) invalid('receipt does not match the source-bound measurement.');
  const evidence = descriptors.evidence.value;
  exactObject(evidence, ['localOnly', 'sourceBound', 'nativeAnnotations', 'helperReopened', 'popplerParsed', 'allPagesRendered', 'sourceUnchanged'], 'evidence');
  if (Object.values(evidence).some((entry) => entry !== true)) invalid('evidence is incomplete.');
  if (!Array.isArray(descriptors.limitations.value) || descriptors.limitations.value.length < 1 || descriptors.limitations.value.some((entry) => typeof entry !== 'string' || !entry)) invalid('limitations are invalid.');
  return deepFreeze(value);
}

export const validateReviewMeasurementResult = validatePdfReviewMeasurementResult;
export { UNIT_METERS };
