import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const INCREMENTAL_METADATA_PROFILE = 'local-classic-incremental-metadata-v1';
export const STANDARD_METADATA_FIELDS = Object.freeze([
  'title', 'author', 'subject', 'keywords',
]);
export const INCREMENTAL_METADATA_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'classic-xref-proof', 'poppler-metadata',
  'pdfsig-output-unsigned', 'poppler-page-count', 'poppler-page-text',
  'poppler-page-boxes', 'poppler-render-all-pages', 'xmp-absent',
  'source-unchanged', 'artifact-sha256',
]);
export const INCREMENTAL_METADATA_LIMITATIONS = Object.freeze([
  'Only the supported bounded xref subset is accepted; admitted xref/object streams may use the fixed control-filter pipelines, while encryption, signatures, XMP, and inputs where Poppler detects forms, JavaScript, attachments, or URLs are rejected.',
  'The append-only revision retains historical metadata bytes in prior revisions.',
  'This operation is not sanitization or privacy removal, and its explicit gates do not establish broader active-content safety.',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'sourcePrefixPreserved', 'priorObjectOffsetsPreserved',
  'rootReferencePreserved', 'freshInfoObjectAllocated',
  'classicIncrementalRevisionAppended', 'popplerMetadataMatched',
  'pageCountMatched', 'pageTextMatched', 'pageGeometryMatched', 'pageRendersMatched',
  'outputUnsigned', 'xmpAbsent', 'artifactDigestBound', 'sourceUnchanged', 'localOnly',
]);

function safeMetadataText(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || value.normalize('NFC') !== value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > 1_024) return false;
  for (const symbol of value) {
    const point = symbol.codePointAt(0);
    if ((point >= 0xd800 && point <= 0xdfff) || /[\p{Cc}\p{Cf}]/u.test(symbol)) return false;
  }
  return true;
}

export function validIncrementalMetadata(value) {
  return exactObject(value, STANDARD_METADATA_FIELDS)
    && Object.values(value).every(safeMetadataText);
}

export function buildStandardMetadataMutation(state) {
  const metadata = Object.fromEntries(STANDARD_METADATA_FIELDS.map((key) => {
    const value = String(state?.pdfkitMetadata?.[key] ?? '');
    if (new TextEncoder().encode(value).byteLength > 1_024) {
      throw new Error(`PDF metadata ${key} exceeds 1,024 UTF-8 bytes.`);
    }
    if (!safeMetadataText(value)) {
      throw new Error(`PDF metadata ${key} must be trimmed NFC text without control characters and no more than 1,024 UTF-8 bytes.`);
    }
    return [key, value === '' ? null : value];
  }));
  return Object.freeze(metadata);
}

function invalidResult() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid incremental-metadata result.',
  );
}

function validArtifact(artifact, documentId, sourceSha256) {
  return exactObject(artifact, [
    'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt',
  ])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== documentId
    && artifact.documentId === documentId && OPAQUE_ID_PATTERN.test(documentId ?? '')
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240 && !/[\u0000-\u001f\u007f]/.test(artifact.displayName)
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 1
    && artifact.size <= 256 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== sourceSha256
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}

function validOperation(operation, { documentId, sourceSha256, outputSha256, updatedFields }) {
  return exactObject(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt',
  ])
    && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '')
    && operation.type === 'pdf-incremental-metadata'
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === documentId
    && operation.inputs[0].sha256 === sourceSha256 && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'updatedFields'])
    && operation.parameters.profile === INCREMENTAL_METADATA_PROFILE
    && sameFields(operation.parameters.updatedFields, updatedFields)
    && exactObject(operation.expected, [
      'pageCount', 'sourceUnchanged', 'sourcePrefixPreserved', 'rasterized',
    ])
    && Number.isSafeInteger(operation.expected.pageCount)
    && operation.expected.pageCount >= 1 && operation.expected.pageCount <= 100
    && operation.expected.sourceUnchanged === true
    && operation.expected.sourcePrefixPreserved === true
    && operation.expected.rasterized === false
    && validValidation(operation.validation, operation.expected.pageCount, outputSha256);
}

function sameFields(value, expected = STANDARD_METADATA_FIELDS) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((field, index) => field === expected[index]);
}

function validValidation(value, pageCount, outputSha256) {
  return exactObject(value, ['passed', 'validators', 'pageCount', 'outputSha256'])
    && value.passed === true && value.pageCount === pageCount
    && value.outputSha256 === outputSha256
    && sameFields(value.validators, INCREMENTAL_METADATA_VALIDATORS);
}

export function validateIncrementalMetadataResult(result, context) {
  const { documentId, sourceSha256 } = context;
  if (!exactObject(result, [
    'kind', 'sourceDigest', 'artifact', 'metadata', 'evidence', 'limitations',
  ])
    || result.kind !== 'pdf-incremental-metadata' || result.sourceDigest !== sourceSha256
    || !validArtifact(result.artifact, documentId, sourceSha256)
    || !exactObject(result.metadata, ['profile', 'updatedFields'])
    || result.metadata.profile !== INCREMENTAL_METADATA_PROFILE
    || !sameFields(result.metadata.updatedFields)
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !sameFields(result.limitations, INCREMENTAL_METADATA_LIMITATIONS)
    || !validOperation(result.artifact.operation, {
      documentId,
      sourceSha256,
      outputSha256: result.artifact.sha256,
      updatedFields: result.metadata.updatedFields,
    })) invalidResult();
  return result;
}
