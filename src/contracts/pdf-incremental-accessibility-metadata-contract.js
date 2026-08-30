import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE = 'local-incremental-document-language-title-v1';
export const INCREMENTAL_ACCESSIBILITY_METADATA_FIELDS = Object.freeze([
  'documentDefaultLanguage',
  'infoTitle',
]);
export const INCREMENTAL_ACCESSIBILITY_METADATA_VALIDATORS = Object.freeze([
  'source-sha256',
  'private-source-copy',
  'raw-lang-title-proof',
  'pdfsig-output-unsigned',
  'poppler-page-count',
  'poppler-page-text',
  'poppler-page-boxes',
  'poppler-render-all-pages',
  'source-unchanged',
  'artifact-sha256',
]);
export const INCREMENTAL_ACCESSIBILITY_METADATA_LIMITATIONS = Object.freeze([
  'The append-only revision retains historical bytes and metadata in prior revisions.',
  'This operation does not add content-item language, tags, a structure tree, PDF/UA conformance, sanitization, or signature preservation.',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified',
  'sourcePrefixPreserved',
  'appendOnlyHistoryRetained',
  'rawLanguageAndTitleMatched',
  'outputUnsigned',
  'pageCountMatched',
  'pageTextMatched',
  'pageGeometryMatched',
  'pageRendersMatched',
  'artifactDigestBound',
  'sourceUnchanged',
  'localOnly',
]);

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function sameList(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

export function validIncrementalAccessibilityMetadata(value) {
  return exactObject(value, ['language', 'title'])
    && typeof value.language === 'string' && value.language.length <= 35
    && /^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?$/.test(value.language)
    && typeof value.title === 'string' && value.title.length >= 1 && value.title.length <= 256
    && value.title.normalize('NFC') === value.title && value.title.trim() === value.title
    && !hasUnpairedSurrogate(value.title) && !/[\p{Cc}\p{Cf}]/u.test(value.title);
}

function validArtifact(artifact, context) {
  return exactObject(artifact, [
    'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
  ])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '')
    && artifact.id !== context.documentId
    && artifact.documentId === context.documentId
    && typeof artifact.displayName === 'string'
    && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(artifact.displayName)
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size)
    && artifact.size >= 1
    && artifact.size <= 129 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '')
    && artifact.sha256 !== context.sourceSha256
    && typeof artifact.createdAt === 'string'
    && !Number.isNaN(Date.parse(artifact.createdAt));
}

function validOperation(operation, artifact, context) {
  const pageCount = operation?.expected?.pageCount;
  return exactObject(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt',
  ])
    && operation.schemaVersion === 1
    && OPAQUE_ID_PATTERN.test(operation.id ?? '')
    && operation.type === 'pdf-incremental-accessibility-metadata'
    && typeof operation.completedAt === 'string'
    && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs)
    && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256
    && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'updatedFields', 'requestSha256'])
    && operation.parameters.profile === INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE
    && sameList(operation.parameters.updatedFields, INCREMENTAL_ACCESSIBILITY_METADATA_FIELDS)
    && operation.parameters.requestSha256 === context.requestSha256
    && exactObject(operation.expected, [
      'pageCount', 'sourceUnchanged', 'sourcePrefixPreserved', 'rasterized',
    ])
    && Number.isSafeInteger(pageCount)
    && pageCount >= 1
    && pageCount <= 100
    && operation.expected.sourceUnchanged === true
    && operation.expected.sourcePrefixPreserved === true
    && operation.expected.rasterized === false
    && exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'outputSha256'])
    && operation.validation.passed === true
    && sameList(operation.validation.validators, INCREMENTAL_ACCESSIBILITY_METADATA_VALIDATORS)
    && operation.validation.pageCount === pageCount
    && operation.validation.outputSha256 === artifact.sha256;
}

function invalidResult() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid source-bound incremental accessibility metadata result.',
  );
}

export function validateIncrementalAccessibilityMetadataResult(result, context) {
  if (!validIncrementalAccessibilityMetadata(context.request)
    || !exactObject(result, [
      'kind', 'sourceDigest', 'artifact', 'metadata', 'evidence', 'limitations',
    ])
    || result.kind !== 'pdf-incremental-accessibility-metadata'
    || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context)
    || !exactObject(result.metadata, ['profile', 'updatedFields', 'requestSha256'])
    || result.metadata.profile !== INCREMENTAL_ACCESSIBILITY_METADATA_PROFILE
    || !sameList(result.metadata.updatedFields, INCREMENTAL_ACCESSIBILITY_METADATA_FIELDS)
    || result.metadata.requestSha256 !== context.requestSha256
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !sameList(result.limitations, INCREMENTAL_ACCESSIBILITY_METADATA_LIMITATIONS)
    || !validOperation(result.artifact.operation, result.artifact, context)) invalidResult();
  return result;
}
