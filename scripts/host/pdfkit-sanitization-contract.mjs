import { HostError } from './host-error.mjs';

export const SANITIZATION_CATEGORY_ORDER = Object.freeze(['document-info', 'custom-info', 'xmp']);
const MAX_REQUEST_BYTES = 2 * 1024;

function fail(code, message, status = 400) { throw new HostError(code, message, status); }

export function buildMetadataSanitizationRequest(sourceSha256, limits) {
  const bytes = Buffer.from(JSON.stringify({ version: 1, operation: 'sanitizeMetadata', inputFilename: 'input.pdf', outputFilename: 'output.pdf', sourceSha256, limits }), 'utf8');
  if (bytes.length > MAX_REQUEST_BYTES) { bytes.fill(0); fail('INVALID_PDFKIT_SANITIZATION_OPTIONS', 'The fixed metadata-sanitization request is too large.', 413); }
  return bytes;
}

export function categoriesMatch(actual, expected) { return Array.isArray(actual) && actual.length === expected.length && actual.every((category, index) => category === expected[index]) && actual.every((category) => SANITIZATION_CATEGORY_ORDER.includes(category)); }

export function receiptMatchesMetadataContract(result, source, categories, pageCount) {
  return result.sourceSha256 === source.sha256 && result.outputSha256 !== source.sha256 && result.pageCount === pageCount && categoriesMatch(result.observedCategories, categories) && result.freshDocumentCopy === true && result.metadataAbsent === true && result.contentSnapshotMatched === true && result.reopenVerified === true;
}
