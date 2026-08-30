import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_ATTACHMENT_REMOVAL_PROFILE = 'local-document-attachment-removal-v1';
export const PDF_ATTACHMENT_REMOVAL_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy',
  'poppler-attachment-extract-before-after', 'raw-logical-deletion-proof',
  'raw-closed-rewrite-proof', 'poppler-page-count-text-boxes',
  'poppler-render-equality-256px-all-pages', 'pdfsig-output-unsigned',
  'artifact-sha256',
]);
export const PDF_ATTACHMENT_REMOVAL_LIMITATIONS = Object.freeze([
  'Only a bounded classic-xref source with one exact flat document-level attachment locus and one matching 1–240-byte printable-ASCII name is accepted.',
  'The one attachment is removed through verified logical deletion and a closed rewrite. Actions, forms, signatures, active content, shared targets, and unsupported graphs fail closed.',
  'The source remains unchanged. This is not attachment addition, extraction, rename, multi-attachment management, or signature preservation.',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'attachmentMatchedBefore',
  'attachmentContentDigestBound', 'attachmentAbsentAfter',
  'logicalDeletionVerified', 'closedClassicRewriteVerified', 'pageCountMatched',
  'pageTextMatched', 'pageBoxesMatched', 'pageValidationRendersMatched',
  'outputUnsigned', 'artifactDigestBound', 'sourceUnchanged', 'localOnly',
]);

function sameList(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function validArtifact(artifact, context) {
  return exactObject(artifact, [
    'id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation',
    'createdAt',
  ]) && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== context.documentId
    && artifact.documentId === context.documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240 && !/[\u0000-\u001f\u007f]/.test(artifact.displayName)
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64
    && artifact.size <= 65 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== context.sourceSha256
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}

function validRemoval(removal) {
  return exactObject(removal, [
    'profile', 'nameSha256', 'contentSha256', 'contentBytes',
  ]) && removal.profile === PDF_ATTACHMENT_REMOVAL_PROFILE
    && SHA256.test(removal.nameSha256 ?? '') && SHA256.test(removal.contentSha256 ?? '')
    && Number.isSafeInteger(removal.contentBytes)
    && removal.contentBytes >= 1 && removal.contentBytes <= 8 * 1024 * 1024;
}

function validOperation(operation, artifact, context, removal) {
  const pageCount = operation?.expected?.pageCount;
  return exactObject(operation, [
    'schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation',
    'completedAt',
  ]) && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '')
    && operation.type === 'pdf-document-attachment-removal'
    && typeof operation.completedAt === 'string'
    && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256
    && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, [
      'profile', 'nameSha256', 'contentSha256', 'contentBytes',
    ]) && Object.keys(operation.parameters).every(
      (key) => operation.parameters[key] === removal[key],
    ) && exactObject(operation.expected, [
      'pageCount', 'attachmentRemoved', 'sourceUnchanged', 'closedClassicRewrite',
      'priorRevisionsAbsent', 'rasterized',
    ]) && Number.isSafeInteger(pageCount) && pageCount >= 1 && pageCount <= 100
    && operation.expected.attachmentRemoved === true
    && operation.expected.sourceUnchanged === true
    && operation.expected.closedClassicRewrite === true
    && operation.expected.priorRevisionsAbsent === true
    && operation.expected.rasterized === false
    && exactObject(operation.validation, [
      'passed', 'validators', 'pageCount', 'outputSha256',
    ]) && operation.validation.passed === true
    && sameList(operation.validation.validators, PDF_ATTACHMENT_REMOVAL_VALIDATORS)
    && operation.validation.pageCount === pageCount
    && operation.validation.outputSha256 === artifact.sha256;
}

function invalidResult() {
  throw new PlatenError(
    'INVALID_LOCAL_HOST',
    'The local host returned an invalid source-bound attachment-removal result.',
  );
}

export function validatePdfAttachmentRemovalResult(result, context) {
  if (!exactObject(result, [
    'kind', 'sourceDigest', 'artifact', 'removal', 'evidence', 'limitations',
  ]) || result.kind !== 'pdf-document-attachment-removal'
    || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context) || !validRemoval(result.removal)
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !sameList(result.limitations, PDF_ATTACHMENT_REMOVAL_LIMITATIONS)
    || !validOperation(result.artifact.operation, result.artifact, context, result.removal)) {
    invalidResult();
  }
  return result;
}
