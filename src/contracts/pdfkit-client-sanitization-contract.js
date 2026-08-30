import { PlatenError } from './errors.js';
import {
  exactObject,
  OPAQUE_ID_PATTERN,
  PDFKIT_METADATA_SANITIZATION_PROFILE,
} from './pdfkit-client-contract-shared.js';

const PDFKIT_METADATA_SANITIZATION_CATEGORIES = Object.freeze([
  'document-info', 'custom-info', 'xmp',
]);
const PDFKIT_METADATA_SANITIZATION_LIMITATIONS = Object.freeze([
  'This fixed profile removes document Info entries, custom Info entries, and catalog XMP only from a separate derived PDF.',
  'It rejects signatures, encryption, forms, tags, layers, name trees, page labels, active content, attachments, URLs, and unsupported page or catalog graphs instead of silently discarding them.',
  'This is not hidden-data sanitization, prior-revision or orphan-object scrubbing, secure erasure, signature preservation, or byte preservation.',
]);
const PDFKIT_METADATA_SANITIZATION_VALIDATORS = Object.freeze([
  'source-sha256', 'pinned-helper-sha256', 'pdfkit-fresh-document-copy',
  'pdfkit-content-snapshot-match', 'pdfkit-metadata-absent',
  'poppler-document-info-absent', 'poppler-xmp-absent',
  'poppler-custom-info-absent', 'pdfsig-output-unsigned',
  'poppler-page-count', 'poppler-render-all-pages', 'artifact-sha256',
]);
const PDFKIT_METADATA_SANITIZATION_EVIDENCE = Object.freeze([
  'helperBinaryDigestVerified', 'sourceDigestReverified', 'nativeFreshDocumentCopy',
  'nativeContentSnapshotMatched', 'nativeMetadataAbsent', 'popplerMetadataAbsent',
  'popplerCustomMetadataAbsent', 'outputUnsigned', 'allPagesRendered',
  'artifactDigestBound', 'sourceUnchanged',
]);

export function validatePdfKitMetadataSanitizationResult(
  result,
  { documentId, sourceSha256 },
) {
  const invalid = () => {
    throw new PlatenError(
      'INVALID_LOCAL_HOST',
      'The local host returned an invalid PDFKit metadata-sanitization result.',
    );
  };
  if (!exactObject(result, ['kind', 'sourceDigest', 'artifact', 'sanitization', 'evidence', 'limitations'])
    || result.kind !== 'pdfkit-metadata-sanitization'
    || result.sourceDigest !== sourceSha256
    || !exactObject(result.artifact, [
      'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
    ])
    || !OPAQUE_ID_PATTERN.test(result.artifact.id ?? '')
    || result.artifact.id === documentId
    || result.artifact.documentId !== documentId
    || !OPAQUE_ID_PATTERN.test(result.artifact.documentId ?? '')
    || typeof result.artifact.displayName !== 'string' || !result.artifact.displayName
    || result.artifact.displayName.length > 240
    || /[\u0000-\u001f\u007f]/.test(result.artifact.displayName)
    || result.artifact.mediaType !== 'application/pdf'
    || !Number.isSafeInteger(result.artifact.size) || result.artifact.size < 1
    || result.artifact.size > 256 * 1024 * 1024
    || !/^[0-9a-f]{64}$/.test(result.artifact.sha256 ?? '')
    || result.artifact.sha256 === sourceSha256
    || typeof result.artifact.createdAt !== 'string'
    || Number.isNaN(Date.parse(result.artifact.createdAt))
    || !exactObject(result.sanitization, ['profile', 'removedCategories'])
    || result.sanitization.profile !== PDFKIT_METADATA_SANITIZATION_PROFILE
    || !Array.isArray(result.sanitization.removedCategories)
    || result.sanitization.removedCategories.length < 1
    || result.sanitization.removedCategories.length
      > PDFKIT_METADATA_SANITIZATION_CATEGORIES.length
    || result.sanitization.removedCategories.some((category, index) => (
      category !== PDFKIT_METADATA_SANITIZATION_CATEGORIES.filter(
        (candidate) => result.sanitization.removedCategories.includes(candidate),
      )[index]
    ))
    || !exactObject(result.evidence, PDFKIT_METADATA_SANITIZATION_EVIDENCE)
    || PDFKIT_METADATA_SANITIZATION_EVIDENCE.some((key) => result.evidence[key] !== true)
    || !Array.isArray(result.limitations)
    || result.limitations.length !== PDFKIT_METADATA_SANITIZATION_LIMITATIONS.length
    || result.limitations.some(
      (entry, index) => entry !== PDFKIT_METADATA_SANITIZATION_LIMITATIONS[index],
    )) invalid();

  const operation = result.artifact.operation;
  if (!exactObject(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt',
  ])
    || operation.schemaVersion !== 1 || !OPAQUE_ID_PATTERN.test(operation.id ?? '')
    || operation.type !== 'pdfkit-metadata-sanitization'
    || typeof operation.completedAt !== 'string'
    || Number.isNaN(Date.parse(operation.completedAt))
    || !Array.isArray(operation.inputs) || operation.inputs.length !== 1
    || !exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    || operation.inputs[0].documentId !== documentId
    || operation.inputs[0].sha256 !== sourceSha256 || operation.inputs[0].role !== 'source'
    || !exactObject(operation.parameters, ['profile', 'removedCategories'])
    || operation.parameters.profile !== PDFKIT_METADATA_SANITIZATION_PROFILE
    || !Array.isArray(operation.parameters.removedCategories)
    || operation.parameters.removedCategories.length
      !== result.sanitization.removedCategories.length
    || operation.parameters.removedCategories.some(
      (category, index) => category !== result.sanitization.removedCategories[index],
    )
    || !exactObject(operation.expected, [
      'pageCount', 'sourceUnchanged', 'rasterized', 'metadataAbsent',
    ])
    || !Number.isSafeInteger(operation.expected.pageCount)
    || operation.expected.pageCount < 1 || operation.expected.pageCount > 100
    || operation.expected.sourceUnchanged !== true || operation.expected.rasterized !== false
    || !Array.isArray(operation.expected.metadataAbsent)
    || operation.expected.metadataAbsent.length
      !== result.sanitization.removedCategories.length
    || operation.expected.metadataAbsent.some(
      (category, index) => category !== result.sanitization.removedCategories[index],
    )
    || !exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'outputSha256'])
    || operation.validation.passed !== true
    || operation.validation.pageCount !== operation.expected.pageCount
    || operation.validation.outputSha256 !== result.artifact.sha256
    || !Array.isArray(operation.validation.validators)
    || operation.validation.validators.length !== PDFKIT_METADATA_SANITIZATION_VALIDATORS.length
    || operation.validation.validators.some(
      (entry, index) => entry !== PDFKIT_METADATA_SANITIZATION_VALIDATORS[index],
    )) invalid();
  return result;
}
