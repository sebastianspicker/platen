import { isFiniteNumber, isFingerprint, isInteger, isOpaqueIdentifier, parsePdfkitEnvelope, responseError } from './response-common.mjs';

const AEC_MEASUREMENT_PROFILES = Object.freeze({
  distance: Object.freeze({ unit: 'm', calibration: 'required', annotationSubtypes: Object.freeze(['line', 'ink']) }),
  perimeter: Object.freeze({ unit: 'm', calibration: 'required', annotationSubtypes: Object.freeze(['line', 'ink']) }),
  area: Object.freeze({ unit: 'm2', calibration: 'required', annotationSubtypes: Object.freeze(['line', 'ink']) }),
  count: Object.freeze({ unit: 'count', calibration: 'absent', annotationSubtypes: Object.freeze(['circle']) }),
});

const AEC_RECEIPT_FIELDS = Object.freeze([
  'schema', 'version', 'operation', 'sourceSha256', 'outputSha256', 'measurementId',
  'page', 'kind', 'quantity', 'unit', 'calibrationId', 'annotationCount',
  'annotationSubtypes', 'measurementDictionaryEmbedded', 'pageCount',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExpectedReceiptFields(result) {
  return Object.keys(result).length === AEC_RECEIPT_FIELDS.length
    && AEC_RECEIPT_FIELDS.every((field) => Object.hasOwn(result, field));
}

function hasValidReceiptHeader(result) {
  return [
    result.schema === 'pdfkit-aec-measurement-receipt-v1',
    result.version === 1,
    result.operation === 'applyAecMeasurement',
    isFingerprint(result.sourceSha256),
    isFingerprint(result.outputSha256),
    result.sourceSha256 !== result.outputSha256,
    isOpaqueIdentifier(result.measurementId),
    isInteger(result.page, 1, 100),
    isInteger(result.pageCount, 1, 100),
    result.measurementDictionaryEmbedded === false,
  ].every(Boolean);
}

function hasValidMeasurementValues(result) {
  return [
    isFiniteNumber(result.quantity),
    result.quantity > 0,
    isInteger(result.annotationCount, 1, 50),
    Array.isArray(result.annotationSubtypes),
    result.annotationSubtypes.length === result.annotationCount,
    result.annotationSubtypes.every((subtype) => ['line', 'ink', 'circle'].includes(subtype)),
  ].every(Boolean);
}

function hasValidMeasurementSemantics(result) {
  const profile = AEC_MEASUREMENT_PROFILES[result.kind];
  if (!profile) return false;
  if (result.unit !== profile.unit) return false;
  if (profile.calibration === 'absent') {
    return [
      result.calibrationId === null,
      result.annotationSubtypes.every((subtype) => subtype === 'circle'),
    ].every(Boolean);
  }
  return [
    isOpaqueIdentifier(result.calibrationId),
    result.annotationCount === 1,
    profile.annotationSubtypes.includes(result.annotationSubtypes[0]),
  ].every(Boolean);
}

function isValidAecMeasurementReceipt(result) {
  if (!isObject(result)) return false;
  return [
    hasExpectedReceiptFields(result),
    hasValidReceiptHeader(result),
    hasValidMeasurementValues(result),
    hasValidMeasurementSemantics(result),
  ].every(Boolean);
}

export function parsePdfkitAecMeasurementResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  if (!isValidAecMeasurementReceipt(result)) throw responseError();
  return result;
}
