import { PlatenError } from './errors.js';
import { exactObject, OPAQUE_ID_PATTERN } from './pdfkit-client-contract-shared.js';

export const PDF_PAGE_TEXT_PROFILE = 'local-page-text-run-v1';
export const PDF_PAGE_TEXT_VALIDATORS = Object.freeze([
  'source-sha256', 'private-source-copy', 'raw-writer-proof',
  'source-prefix-preserved', 'pdfsig-source-output-unsigned',
  'poppler-passive-envelope', 'poppler-page-count', 'poppler-page-boxes',
  'poppler-target-page-text', 'poppler-render-target-diff-other-pages-match',
  'source-unchanged', 'artifact-sha256',
]);
export const PDF_PAGE_TEXT_LIMITATIONS = Object.freeze([
  'Only strict unsigned, unencrypted, passive classic PDFs with a content-empty target page are accepted.',
  'Text is limited to 512 bytes of canonical printable ASCII and is written with the fixed built-in Helvetica font.',
  'Historical source bytes remain present in the append-only revision; this is not redaction, sanitization, conformance validation, or byte preservation.',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_KEYS = Object.freeze([
  'sourceDigestReverified', 'sourcePrefixPreserved', 'writerProofVerified',
  'pageCountMatched', 'pageBoxesMatched', 'targetPageTextMatched',
  'targetPageRenderDiffered', 'otherPageRendersMatched', 'outputUnsigned',
  'artifactDigestBound', 'sourceUnchanged', 'localOnly',
]);

function sameList(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

export function validPageTextRequest(value) {
  return exactObject(value, ['page', 'x', 'y', 'size', 'text'])
    && Number.isSafeInteger(value.page) && value.page >= 1 && value.page <= 100
    && Number.isSafeInteger(value.x) && Math.abs(value.x) <= 1_000_000
    && Number.isSafeInteger(value.y) && Math.abs(value.y) <= 1_000_000
    && Number.isSafeInteger(value.size) && value.size >= 6 && value.size <= 72
    && typeof value.text === 'string' && value.text.length >= 1
    && value.text.normalize('NFC') === value.text && value.text.trim() === value.text
    && /^[\x20-\x7e]+$/.test(value.text)
    && new TextEncoder().encode(value.text).byteLength <= 512;
}

export function buildPageTextMutation(state) {
  const request = {
    page: Number(state?.selectedPage),
    x: Number(state?.pageTextRun?.x),
    y: Number(state?.pageTextRun?.y),
    size: Number(state?.pageTextRun?.size),
    text: String(state?.pageTextRun?.text ?? ''),
  };
  if (!validPageTextRequest(request)) {
    throw new Error('Page text requires an existing page, integer position, 6-72pt size, and 1-512 bytes of trimmed printable ASCII.');
  }
  return Object.freeze(request);
}

function validArtifact(artifact, context) {
  return exactObject(artifact, ['id', 'documentId', 'displayName', 'mediaType', 'size', 'sha256', 'operation', 'createdAt'])
    && OPAQUE_ID_PATTERN.test(artifact.id ?? '') && artifact.id !== context.documentId
    && artifact.documentId === context.documentId
    && typeof artifact.displayName === 'string' && artifact.displayName.length >= 1
    && artifact.displayName.length <= 240 && !/[\u0000-\u001f\u007f]/.test(artifact.displayName)
    && artifact.mediaType === 'application/pdf'
    && Number.isSafeInteger(artifact.size) && artifact.size >= 64
    && artifact.size <= 129 * 1024 * 1024
    && SHA256.test(artifact.sha256 ?? '') && artifact.sha256 !== context.sourceSha256
    && typeof artifact.createdAt === 'string' && !Number.isNaN(Date.parse(artifact.createdAt));
}

function validOperation(operation, artifact, context) {
  const pageCount = operation?.expected?.pageCount;
  return exactObject(operation, ['schemaVersion', 'id', 'type', 'inputs', 'parameters', 'expected', 'validation', 'completedAt'])
    && operation.schemaVersion === 1 && OPAQUE_ID_PATTERN.test(operation.id ?? '')
    && operation.type === 'pdf-incremental-page-text'
    && typeof operation.completedAt === 'string' && !Number.isNaN(Date.parse(operation.completedAt))
    && Array.isArray(operation.inputs) && operation.inputs.length === 1
    && exactObject(operation.inputs[0], ['documentId', 'sha256', 'role'])
    && operation.inputs[0].documentId === context.documentId
    && operation.inputs[0].sha256 === context.sourceSha256 && operation.inputs[0].role === 'source'
    && exactObject(operation.parameters, ['profile', 'page', 'x', 'y', 'size', 'textSha256'])
    && operation.parameters.profile === PDF_PAGE_TEXT_PROFILE
    && ['page', 'x', 'y', 'size'].every((key) => operation.parameters[key] === context.request[key])
    && operation.parameters.textSha256 === context.textSha256
    && exactObject(operation.expected, ['pageCount', 'sourceUnchanged', 'sourcePrefixPreserved', 'classicIncrementalRevisionAppended', 'rasterized'])
    && Number.isSafeInteger(pageCount) && pageCount >= 1 && pageCount <= 100
    && context.request.page <= pageCount
    && operation.expected.sourceUnchanged === true
    && operation.expected.sourcePrefixPreserved === true
    && operation.expected.classicIncrementalRevisionAppended === true
    && operation.expected.rasterized === false
    && exactObject(operation.validation, ['passed', 'validators', 'pageCount', 'renderedPages', 'outputSha256'])
    && operation.validation.passed === true
    && sameList(operation.validation.validators, PDF_PAGE_TEXT_VALIDATORS)
    && operation.validation.pageCount === pageCount
    && operation.validation.renderedPages === pageCount
    && operation.validation.outputSha256 === artifact.sha256;
}

function invalidResult() {
  throw new PlatenError('INVALID_LOCAL_HOST', 'The local host returned an invalid source-bound page-text result.');
}

export function validatePageTextResult(result, context) {
  if (!validPageTextRequest(context.request) || !SHA256.test(context.textSha256 ?? '')
    || !exactObject(result, ['kind', 'sourceDigest', 'artifact', 'page', 'text', 'evidence', 'limitations', 'rasterized', 'historicalBytesRetained'])
    || result.kind !== 'pdf-page-text-run' || result.sourceDigest !== context.sourceSha256
    || !validArtifact(result.artifact, context) || result.page !== context.request.page
    || !exactObject(result.text, ['page', 'x', 'y', 'size', 'textSha256'])
    || ['page', 'x', 'y', 'size'].some((key) => result.text[key] !== context.request[key])
    || result.text.textSha256 !== context.textSha256
    || !exactObject(result.evidence, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => result.evidence[key] !== true)
    || !sameList(result.limitations, PDF_PAGE_TEXT_LIMITATIONS)
    || result.rasterized !== false || result.historicalBytesRetained !== true
    || !validOperation(result.artifact.operation, result.artifact, context)) invalidResult();
  return result;
}
