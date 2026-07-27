import { isFiniteNumber, isFingerprint, isInteger, isOpaqueIdentifier, parsePdfkitEnvelope, responseError } from './response-common.mjs';

export function parsePdfkitAecMeasurementResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 15
    || result.schema !== 'pdfkit-aec-measurement-receipt-v1' || result.version !== 1
    || result.operation !== 'applyAecMeasurement' || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256)
    || result.sourceSha256 === result.outputSha256 || !isOpaqueIdentifier(result.measurementId)
    || !isInteger(result.page, 1, 100) || !['distance', 'perimeter', 'area', 'count'].includes(result.kind)
    || !isFiniteNumber(result.quantity) || result.quantity <= 0 || !['m', 'm2', 'count'].includes(result.unit)
    || (result.calibrationId !== null && !isOpaqueIdentifier(result.calibrationId))
    || !isInteger(result.annotationCount, 1, 50) || !Array.isArray(result.annotationSubtypes)
    || result.annotationSubtypes.length !== result.annotationCount
    || result.annotationSubtypes.some((subtype) => !['line', 'ink', 'circle'].includes(subtype))
    || result.measurementDictionaryEmbedded !== false || !isInteger(result.pageCount, 1, 100)) throw responseError();
  if ((result.kind === 'count') !== (result.unit === 'count') || (result.kind === 'area') !== (result.unit === 'm2')
    || (['distance', 'perimeter'].includes(result.kind)) !== (result.unit === 'm')
    || (result.kind === 'count') !== (result.calibrationId === null)
    || (result.kind === 'count' && result.annotationSubtypes.some((subtype) => subtype !== 'circle'))
    || (result.kind !== 'count' && (result.annotationCount !== 1 || !['line', 'ink'].includes(result.annotationSubtypes[0])))) throw responseError();
  return result;
}
