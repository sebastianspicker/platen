import { annotationTypes, isFingerprint, isInteger, parsePdfkitEnvelope, responseError } from './response-common.mjs';

const protectionReceipts = Object.freeze({
  'accessibility-only': Object.freeze({ mask: 32, permissions: Object.freeze(['contentAccessibility']) }),
  'copy-accessibility': Object.freeze({ mask: 48, permissions: Object.freeze(['copying', 'contentAccessibility']) }),
  'deny-all': Object.freeze({ mask: 0, permissions: Object.freeze([]) }),
  'print-only': Object.freeze({ mask: 3, permissions: Object.freeze(['printing']) }),
});

function validStructuralSummary(summary, pageCount) {
  return summary && typeof summary === 'object' && !Array.isArray(summary) && Object.keys(summary).length === 3
    && Array.isArray(summary.pageRotations) && summary.pageRotations.length === pageCount
    && Array.isArray(summary.annotationCounts) && summary.annotationCounts.length === pageCount
    && Array.isArray(summary.annotationSubtypes) && summary.annotationSubtypes.length === pageCount
    && summary.pageRotations.every((rotation) => isInteger(rotation, -360, 360))
    && summary.annotationCounts.every((count) => isInteger(count, 0, 50))
    && summary.annotationSubtypes.every((subtypes, index) => Array.isArray(subtypes)
      && subtypes.length === summary.annotationCounts[index] && subtypes.every((subtype) => annotationTypes.has(subtype)));
}

export function parsePdfkitProtectionResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  const expected = Object.hasOwn(protectionReceipts, result?.profile) ? protectionReceipts[result.profile] : null;
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 10
    || result.schema !== 'pdfkit-protection-receipt-v1' || result.version !== 1 || result.operation !== 'protect'
    || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256) || !expected
    || !isInteger(result.pageCount, 1, 100) || !Array.isArray(result.effectivePermissions)
    || !isInteger(result.effectivePermissionMask, 0, 48) || !validStructuralSummary(result.structuralSummary, result.pageCount)
    || result.effectivePermissionMask !== expected.mask || result.effectivePermissions.length !== expected.permissions.length
    || result.effectivePermissions.some((entry, index) => entry !== expected.permissions[index])) throw responseError();
  return result;
}

export function parsePdfkitProtectionRemovalResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 11
    || result.schema !== 'pdfkit-deprotection-receipt-v1' || result.version !== 1 || result.operation !== 'removeProtection'
    || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256) || result.sourceSha256 === result.outputSha256
    || !Object.hasOwn(protectionReceipts, result.sourceProfile) || !isInteger(result.pageCount, 1, 100)
    || result.ownerAuthorizationVerified !== true || result.encryptionRemoved !== true || result.reopenVerified !== true
    || !validStructuralSummary(result.structuralSummary, result.pageCount)) throw responseError();
  return result;
}
