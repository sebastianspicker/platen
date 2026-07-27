import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const FULL_PAGE_REDACTION_PROFILE = 'local-object-full-page-redaction-v1';
export const FULL_PAGE_REDACTION_BATCH_PROFILE = 'local-object-full-page-redaction-batch-v1';
export const FULL_PAGE_REDACTION_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-closed-redaction-proof',
  'poppler-page-count-text-boxes', 'poppler-target-text-empty',
  'poppler-target-render-black', 'poppler-nontarget-text-render-equality',
  'pdfsig-output-unsigned', 'attachments-and-urls-absent', 'artifact-sha256',
]);
export const FULL_PAGE_REDACTION_LIMITATIONS = Object.freeze([
  'Only one full-page target in a bounded, unsigned, unencrypted, passive PDF is supported.',
  'The target page content and reachable resources are replaced in a closed compact rewrite; this is not region redaction.',
  'This operation does not claim whole-document sanitization, signature preservation, PDF/A, PDF/UA, PDF/X, or print-production equivalence.',
]);
export const FULL_PAGE_REDACTION_BATCH_LIMITATIONS = Object.freeze([
  'Only 1–32 unique sorted full-page targets in a bounded passive PDF are supported.',
  'This operation does not claim whole-document sanitization, signature preservation, or label-based navigation.',
]);
const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'closedCompactRewrite', 'targetContentResourcesRemoved',
  'pageCountMatched', 'targetTextEmpty', 'targetRenderBlack',
  'nonTargetTextRenderMatched', 'outputUnsigned', 'attachmentsAbsent', 'urlsAbsent',
  'artifactDigestBound', 'sourceUnchanged', 'localOnly',
]);
const sameList = (value, expected) => Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);

export function validFullPageRedactionRequest(value) {
  return exactObject(value, ['page']) && Number.isSafeInteger(value.page) && value.page >= 1 && value.page <= 100;
}

export function buildFullPageRedactionMutation(state) {
  const value = { page: Number(state?.selectedPage) };
  if (!validFullPageRedactionRequest(value)) throw new Error('Object-level redaction requires one selected page.');
  return Object.freeze(value);
}

function validArtifact(artifact, context) {
  return exactObject(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== context.documentId && artifact.documentId === context.documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1 && artifact.displayName.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(artifact.displayName)
    && artifact.mediaType === 'application/pdf' && Number.isSafeInteger(artifact.size) && artifact.size >= 64 && artifact.size <= 129 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== context.sourceSha256 && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}

function validOperation(operation, artifact, context) {
  return exactObject(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '') && operation.type === 'pdf-full-page-redaction'
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt)) && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role']) && operation.inputs[0].documentId === context.documentId && operation.inputs[0].sha256 === context.sourceSha256 && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'page']) && operation.parameters.profile === FULL_PAGE_REDACTION_PROFILE && operation.parameters.page === context.request.page
    && exactObject(operation.expected, ['pageCount', 'sourceUnchanged', 'closedCompactRewrite', 'fullPageOnly']) && Number.isSafeInteger(operation.expected.pageCount) && operation.expected.pageCount >= 1 && operation.expected.pageCount <= 100 && operation.expected.sourceUnchanged === true && operation.expected.closedCompactRewrite === true && operation.expected.fullPageOnly === true
    && exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'targetPage', 'outputSha256']) && operation.validation.passed === true && sameList(operation.validation.validators, FULL_PAGE_REDACTION_VALIDATORS) && operation.validation.pageCount === operation.expected.pageCount && operation.validation.targetPage === context.request.page && operation.validation.outputSha256 === artifact.sha256;
}

function invalidResult() { throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid source-bound full-page redaction result.'); }

export function validateFullPageRedactionResult(result, context) {
  if (!exactObject(result, ['kind', 'sourceDigest', 'artifact', 'redaction', 'evidence', 'limitations']) || result.kind !== 'pdf-full-page-redaction' || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context) || !exactObject(result.redaction, ['page', 'fullPage']) || result.redaction.page !== context.request.page || result.redaction.fullPage !== true
    || !exactObject(result.evidence, EVIDENCE_KEYS) || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true) || !sameList(result.limitations, FULL_PAGE_REDACTION_LIMITATIONS)
    || !validOperation(result.artifact.operation, result.artifact, context)) invalidResult();
  return result;
}

const BATCH_EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'closedCompactRewrite', 'targetContentResourcesRemoved',
  'pageCountMatched', 'targetTextEmpty', 'targetPagesBlack', 'nonTargetTextRenderMatched', 'outputUnsigned',
  'attachmentsAbsent', 'urlsAbsent', 'artifactDigestBound', 'sourceUnchanged', 'fullPageOnly', 'localOnly',
]);

function validBatchOperation(operation, artifact, context) {
  return exactObject(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '') && operation.type === 'pdf-full-page-redaction-batch'
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role']) && operation.inputs[0].documentId === context.documentId && operation.inputs[0].sha256 === context.sourceSha256 && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'pages']) && operation.parameters.profile === FULL_PAGE_REDACTION_BATCH_PROFILE && sameList(operation.parameters.pages, context.request.pages)
    && exactObject(operation.expected, ['pageCount', 'sourceUnchanged', 'closedCompactRewrite', 'fullPageOnly']) && Number.isSafeInteger(operation.expected.pageCount) && operation.expected.pageCount >= 1 && operation.expected.pageCount <= 100 && operation.expected.sourceUnchanged === true && operation.expected.closedCompactRewrite === true && operation.expected.fullPageOnly === true
    && exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'targetPages', 'outputSha256']) && operation.validation.passed === true && sameList(operation.validation.validators, FULL_PAGE_REDACTION_VALIDATORS) && operation.validation.pageCount === operation.expected.pageCount && sameList(operation.validation.targetPages, context.request.pages) && operation.validation.outputSha256 === artifact.sha256;
}

export function validFullPageRedactionBatchRequest(value) {
  return exactObject(value, ['pages']) && Array.isArray(value.pages) && value.pages.length >= 1 && value.pages.length <= 32
    && value.pages.every((page, index) => Number.isSafeInteger(page) && page >= 1 && page <= 100 && (index === 0 || page > value.pages[index - 1]));
}

export function validateFullPageRedactionBatchResult(result, context) {
  if (!exactObject(result, ['kind', 'sourceDigest', 'artifact', 'pages', 'evidence', 'limitations'])
    || result.kind !== 'pdf-full-page-redaction-batch' || result.sourceDigest !== context.sourceSha256
    || !validFullPageRedactionBatchRequest({ pages: result.pages }) || !sameList(result.pages, context.request.pages)
    || !validArtifact(result.artifact, context) || !exactObject(result.evidence, BATCH_EVIDENCE_KEYS)
    || BATCH_EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !sameList(result.limitations, FULL_PAGE_REDACTION_BATCH_LIMITATIONS)
    || !validBatchOperation(result.artifact.operation, result.artifact, context)) invalidResult();
  return result;
}
