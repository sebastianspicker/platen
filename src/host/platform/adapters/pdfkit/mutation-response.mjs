import { isFingerprint, isInteger, parsePdfkitEnvelope, responseError } from './response-common.mjs';
import { validInspectionResult } from './inspection-response.mjs';

export function parsePdfkitMutationResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 8
    || result.schema !== 'pdfkit-mutation-receipt-v1' || result.version !== 1
    || result.operation !== 'mutate' || result.category !== 'structure-mutation'
    || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256)
    || result.sourceSha256 === result.outputSha256
    || ![1, 4].includes(result.appliedEdits) || !validInspectionResult(result.inspection)) throw responseError();
  return result;
}

export function parsePdfkitTargetedMutationResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  const propertyKeys = [
    'annotationPropertiesGeometryVerified', 'annotationPropertiesColorVerified',
    'rawAnnotationColorVerified', 'nonTargetAnnotationsVerified', 'targetAnnotationPreservationVerified',
  ];
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 14
    || result.schema !== 'pdfkit-targeted-mutation-receipt-v1' || result.version !== 1
    || result.operation !== 'targetedMutate' || !['targeted-mutation', 'annotation-properties'].includes(result.category)
    || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256)
    || result.sourceSha256 === result.outputSha256 || !isInteger(result.pageCount, 1, 100)
    || result.appliedEdits !== 1 || result.reopenVerified !== true
    || propertyKeys.some((key) => typeof result[key] !== 'boolean')) throw responseError();
  return result;
}

function parseAnnotationReceipt(stdout, schema, operation, category, proofKey) {
  const result = parsePdfkitEnvelope(stdout);
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 13
    || result.schema !== schema || result.version !== 1 || result.operation !== operation || result.category !== category
    || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256)
    || result.sourceSha256 === result.outputSha256 || !isInteger(result.page, 1, 100)
    || !isInteger(result.annotationIndex, 0, 49) || !isInteger(result.pageCount, 1, 100)
    || result.page > result.pageCount || result.appliedEdits !== 1 || result.geometryVerified !== true
    || result[proofKey] !== true || result.reopenVerified !== true) throw responseError();
  return result;
}

export function parsePdfkitLocalGoToResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 14
    || result.schema !== 'pdfkit-local-goto-receipt-v1' || result.version !== 1
    || result.operation !== 'addLocalGoToLink' || result.category !== 'local-goto-link'
    || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256)
    || result.sourceSha256 === result.outputSha256 || !isInteger(result.sourcePage, 1, 100)
    || !isInteger(result.targetPage, 1, 100) || !isInteger(result.annotationIndex, 0, 49)
    || !isInteger(result.pageCount, 1, 100) || result.sourcePage > result.pageCount
    || result.targetPage > result.pageCount || result.appliedEdits !== 1
    || result.rawDestinationVerified !== true || result.localGoToActionVerified !== true
    || result.reopenVerified !== true) throw responseError();
  return result;
}

export function parsePdfkitLocalGoToRemovalResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== 15
    || result.schema !== 'pdfkit-local-goto-removal-receipt-v1' || result.version !== 1
    || result.operation !== 'removeLocalGoToLink'
    || result.category !== 'local-goto-link-removal'
    || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256)
    || result.sourceSha256 === result.outputSha256
    || !isInteger(result.page, 1, 100) || !isInteger(result.annotationIndex, 0, 49)
    || !isInteger(result.pageCount, 1, 100) || result.page > result.pageCount
    || result.appliedEdits !== 1 || result.rawTargetVerified !== true
    || result.annotationRemoved !== true || result.pageGeometryVerified !== true
    || result.annotationInventoryVerified !== true || result.reopenVerified !== true) {
    throw responseError();
  }
  return result;
}

export function parsePdfkitOutlineBookmarkResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== 17
    || result.schema !== 'pdfkit-outline-bookmark-receipt-v1' || result.version !== 1
    || result.operation !== 'appendOutlineBookmark' || result.category !== 'outline-bookmark'
    || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256)
    || !isFingerprint(result.labelSha256) || result.sourceSha256 === result.outputSha256
    || !isInteger(result.page, 1, 100) || !isInteger(result.pageCount, 1, 100)
    || result.page > result.pageCount || result.appliedEdits !== 1
    || result.outlineAppended !== true || result.destinationVerified !== true
    || result.priorOutlineTreeVerified !== true || result.pageGeometryVerified !== true
    || result.annotationInventoryVerified !== true || result.rawDestinationVerified !== true
    || result.reopenVerified !== true) throw responseError();
  return result;
}

export function parsePdfkitOutlineBookmarkRemovalResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== 16
    || result.schema !== 'pdfkit-outline-removal-receipt-v1'
    || result.version !== 1 || result.operation !== 'removeOutlineBookmark'
    || result.category !== 'outline-bookmark-removal'
    || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256)
    || result.sourceSha256 === result.outputSha256
    || !isInteger(result.topLevelIndex, 0, 199)
    || !isInteger(result.pageCount, 1, 100) || result.appliedEdits !== 1
    || result.rawTargetVerified !== true || result.outlineRemoved !== true
    || result.remainingOutlineTreeVerified !== true
    || result.pageGeometryVerified !== true
    || result.annotationInventoryVerified !== true
    || result.contentSnapshotVerified !== true || result.reopenVerified !== true) {
    throw responseError();
  }
  return result;
}

export function parsePdfkitOutlineBookmarkRenameResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== 17
    || result.schema !== 'pdfkit-outline-rename-receipt-v1'
    || result.version !== 1 || result.operation !== 'renameOutlineBookmark'
    || result.category !== 'outline-bookmark-rename'
    || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256)
    || !isFingerprint(result.labelSha256) || result.sourceSha256 === result.outputSha256
    || !isInteger(result.topLevelIndex, 0, 199)
    || !isInteger(result.pageCount, 1, 100) || result.appliedEdits !== 1
    || result.rawTargetVerified !== true || result.outlineRenamed !== true
    || result.remainingOutlineTreeVerified !== true
    || result.pageGeometryVerified !== true
    || result.annotationInventoryVerified !== true
    || result.contentSnapshotVerified !== true || result.reopenVerified !== true) {
    throw responseError();
  }
  return result;
}

export function parsePdfkitLineAnnotationResponse(stdout) {
  return parseAnnotationReceipt(stdout, 'pdfkit-line-receipt-v1', 'addLineAnnotation', 'line-annotation', 'lineStylesVerified');
}

export function parsePdfkitInkAnnotationResponse(stdout) {
  return parseAnnotationReceipt(stdout, 'pdfkit-ink-receipt-v1', 'addInkAnnotation', 'ink-annotation', 'rawInkListVerified');
}
