import { isFingerprint, isInteger, parsePdfkitEnvelope, responseError } from './response-common.mjs';

export function parsePdfkitMetadataSanitizationResponse(stdout) {
  const result = parsePdfkitEnvelope(stdout);
  const categories = ['document-info', 'custom-info', 'xmp'];
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 11
    || result.schema !== 'pdfkit-metadata-sanitization-receipt-v1' || result.version !== 1
    || result.operation !== 'sanitizeMetadata' || !isFingerprint(result.sourceSha256) || !isFingerprint(result.outputSha256)
    || result.sourceSha256 === result.outputSha256 || !isInteger(result.pageCount, 1, 100)
    || !Array.isArray(result.observedCategories) || result.observedCategories.length < 1
    || result.observedCategories.length > categories.length || result.observedCategories.some((category) => !categories.includes(category))
    || new Set(result.observedCategories).size !== result.observedCategories.length
    || result.observedCategories.some((category, index) => categories.indexOf(category) <= categories.indexOf(result.observedCategories[index - 1] ?? ''))
    || result.freshDocumentCopy !== true || result.metadataAbsent !== true
    || result.contentSnapshotMatched !== true || result.reopenVerified !== true) throw responseError();
  return result;
}
